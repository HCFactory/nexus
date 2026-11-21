import { timingSafeEqual } from 'node:crypto';

import { runScheduledSync } from '@/lib/businessCentral/sync/scheduledSync';
import { runReceivablesSync } from '@/lib/businessCentral/sync/receivablesSync';
import { recordSyncRun } from '@/lib/businessCentral/sync/syncRuns';
import { createServiceClient } from '@/lib/supabase/server';
import type { BusinessCentralConnection } from '@/types/database';

// Called by Supabase pg_cron (every 15 min: light, every 2 h: full). Vercel
// Hobby allows 300 s per call: stay under 270 s, and only start a round when a
// worst-case round still fits (full ≈ 60 s receivables + 30 s cards + 40 s
// lines + 30 s Bill.com status + 20 s Bill.com payments + page fetches and
// ship-tos; light ≈ 30 s cards + customers + ship-tos).
export const maxDuration = 300;
export const dynamic = 'force-dynamic';
const LIMIT_MS = 270_000;
// Each Bill.com step can run one request past its window (client timeout + retry).
const WORST_ROUND_MS = { full: 255_000, light: 90_000 } as const;

function authorized(header: string | null, secret: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '');
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return Response.json({ error: 'Scheduled sync is not set up (CRON_SECRET is missing).' }, { status: 503 });
  if (!authorized(request.headers.get('authorization'), secret)) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const kind = new URL(request.url).searchParams.get('kind');
  if (kind !== 'light' && kind !== 'full') return Response.json({ error: 'kind must be light or full' }, { status: 400 });

  const supabase = createServiceClient();
  const { data, error } = await supabase.from('business_central_connections').select('*').eq('auto_sync', true);
  if (error) return Response.json({ error: `Could not read environments: ${error.message}` }, { status: 500 });
  const connections = (data ?? []) as BusinessCentralConnection[];
  const byId = new Map(connections.map((c) => [c.id, c]));

  const outcomes = await runScheduledSync({
    kind,
    connections: connections.map((c) => c.id),
    nowMs: () => Date.now(),
    limitMs: LIMIT_MS,
    worstRoundMs: WORST_ROUND_MS[kind],
    round: (connectionId) => {
      const connection = byId.get(connectionId)!;
      const orgId = connection.organization_id;
      return recordSyncRun(supabase, { orgId, connectionId, kind, trigger: 'scheduled', triggeredBy: null }, () =>
        runReceivablesSync({ supabase, orgId, connection, kind, lockedBy: null }),
      );
    },
  });
  for (const o of outcomes) if (o.status !== 'ok') console.error(`[cron sync ${kind}] ${o.connectionId}: ${o.status}`);
  return Response.json({ kind, outcomes });
}
