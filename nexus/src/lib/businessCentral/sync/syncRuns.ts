import 'server-only';

import type { SyncEntityResult } from '@/lib/businessCentral/syncRunner';
import type { createServiceClient } from '@/lib/supabase/server';

type Db = ReturnType<typeof createServiceClient>;

import { SyncInProgressError } from './syncRunsError';

export { SyncInProgressError };

export type SyncRunKind = 'light' | 'full' | 'lists';

export interface SyncRunMeta {
  orgId: string;
  connectionId: string;
  kind: SyncRunKind;
  trigger: 'manual' | 'scheduled';
  triggeredBy: string | null;
}

/**
 * Runs one sync round and records it in bc_sync_runs (start, then finish with
 * outcome). Logging is best effort: it never stops or fails the sync. A round
 * that found the lock held leaves no row behind.
 */
export async function recordSyncRun(
  db: Db,
  meta: SyncRunMeta,
  run: () => Promise<SyncEntityResult[]>,
): Promise<SyncEntityResult[]> {
  let runId: string | null = null;
  try {
    const { data, error } = await db
      .from('bc_sync_runs')
      .insert({
        organization_id: meta.orgId,
        bc_connection_id: meta.connectionId,
        kind: meta.kind,
        trigger: meta.trigger,
        triggered_by: meta.triggeredBy,
      })
      .select('id')
      .single();
    if (error) throw error;
    runId = (data as { id: string }).id;
  } catch (e) {
    console.error('[sync] could not record the sync run (sync continues):', e instanceof Error ? e.message : e);
  }

  const finish = async (patch: Record<string, unknown>) => {
    if (!runId) return;
    try {
      const { error } = await db
        .from('bc_sync_runs')
        .update({ finished_at: new Date().toISOString(), ...patch })
        .eq('id', runId);
      if (error) throw error;
    } catch (e) {
      console.error('[sync] could not record the sync result:', e instanceof Error ? e.message : e);
    }
  };

  try {
    const results = await run();
    const errors = results.filter((r) => r.error).map((r) => `${r.entityType}: ${r.error}`);
    await finish({
      complete: results.every((r) => r.complete && !r.error),
      error: errors.length ? errors.join('; ') : null,
      results,
    });
    return results;
  } catch (e) {
    if (e instanceof SyncInProgressError) {
      if (runId) await Promise.resolve(db.from('bc_sync_runs').delete().eq('id', runId)).catch(() => undefined);
    } else {
      await finish({ complete: false, error: e instanceof Error ? e.message : String(e) });
    }
    throw e;
  }
}
