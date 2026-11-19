'use server';

import { requireActiveBusinessCentralScope } from '@/lib/businessCentral/environmentScope';
import { createServiceClient } from '@/lib/supabase/server';

export interface SyncRunSummary {
  startedAt: string;
  finishedAt: string | null;
  trigger: 'manual' | 'scheduled';
  complete: boolean | null;
  error: string | null;
}

export interface SyncOverview {
  environment: string;
  autoSync: boolean;
  runs: Record<'full' | 'lists' | 'light', SyncRunSummary | null>;
}

type RunRow = { started_at: string; finished_at: string | null; trigger: 'manual' | 'scheduled'; complete: boolean | null; error: string | null };

/** Admin → Sync: the active environment and the latest run of each sync. Null when not an admin or no environment. */
export async function getSyncOverview(): Promise<SyncOverview | null> {
  let scope;
  try {
    scope = await requireActiveBusinessCentralScope();
  } catch {
    return null;
  }
  if (!scope.access.isAdmin) return null;
  const supabase = createServiceClient();

  const { data: conn } = await supabase
    .from('business_central_connections')
    .select('display_name, auto_sync')
    .eq('id', scope.bcConnectionId)
    .eq('organization_id', scope.orgId)
    .maybeSingle();

  const latest = async (kind: 'full' | 'lists' | 'light'): Promise<SyncRunSummary | null> => {
    // Missing table (migration 072 not applied yet) reads as "never run".
    const { data } = await supabase
      .from('bc_sync_runs')
      .select('started_at, finished_at, trigger, complete, error')
      .eq('organization_id', scope.orgId)
      .eq('bc_connection_id', scope.bcConnectionId)
      .eq('kind', kind)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const r = data as RunRow | null;
    return r ? { startedAt: r.started_at, finishedAt: r.finished_at, trigger: r.trigger, complete: r.complete, error: r.error } : null;
  };
  const [full, lists, light] = await Promise.all([latest('full'), latest('lists'), latest('light')]);
  const c = conn as { display_name?: string; auto_sync?: boolean } | null;
  return { environment: c?.display_name ?? '', autoSync: c?.auto_sync === true, runs: { full, lists, light } };
}
