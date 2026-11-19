import type { createServiceClient } from '@/lib/supabase/server';

type Db = ReturnType<typeof createServiceClient>;

/**
 * Takes an environment's sync lock in one guarded update, so two syncs can't
 * both win: it only matches while the lock is free or expired, as the
 * database sees it right now (never a copy read earlier). True when taken.
 */
export async function acquireSyncLock(
  db: Db,
  connectionId: string,
  lockedBy: string | null,
  nowIso: string,
  untilIso: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('business_central_connections')
    .update({ sync_in_progress_by: lockedBy, sync_in_progress_since: nowIso, sync_in_progress_timeout_at: untilIso, updated_at: nowIso })
    .eq('id', connectionId)
    .or(`sync_in_progress_since.is.null,sync_in_progress_timeout_at.lt.${nowIso}`)
    .select('id');
  if (error) throw new Error(`Could not take the sync lock: ${error.message}`);
  return (data ?? []).length > 0;
}

/** Clears the lock only if it is still the one this run took (same start time), with any extra columns. */
export async function releaseSyncLock(db: Db, connectionId: string, lockedSince: string, extra: Record<string, unknown>): Promise<void> {
  await db
    .from('business_central_connections')
    .update({ ...extra, sync_in_progress_by: null, sync_in_progress_since: null, sync_in_progress_timeout_at: null, updated_at: lockedSince })
    .eq('id', connectionId)
    .eq('sync_in_progress_since', lockedSince);
}
