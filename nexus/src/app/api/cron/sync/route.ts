import { timingSafeEqual } from 'node:crypto';

import { runScheduledSync } from '@/lib/businessCentral/sync/scheduledSync';
import { runReceivablesSync } from '@/lib/businessCentral/sync/receivablesSync';
import { recordSyncRun } from '@/lib/businessCentral/sync/syncRuns';
import { createServiceClient } from '@/lib/supabase/server';
import type { BusinessCentralConnection } from '@/types/database';

// Called by Supabase pg_cron (every 15 min: light, every 2 h: full). Vercel
// Hobby allows ~5 min per call; full rounds stop starting after 4 min.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';
const FULL_BUDGET_MS = 240_000;

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
    budgetMs: FULL_BUDGET_MS,
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
