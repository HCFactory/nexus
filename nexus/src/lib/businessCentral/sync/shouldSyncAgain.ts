import type { SyncEntityResult } from '@/lib/businessCentral/syncRunner';

/**
 * Run another round while some part is incomplete without an error and moved
 * forward (synced records, or its cursor changed since the last round). An
 * error alone (e.g. a missing BC page) never repeats on its own.
 */
export function shouldSyncAgain(results: SyncEntityResult[], previous: SyncEntityResult[] | null): boolean {
  return results.some(
    (r, i) => !r.complete && !r.error && (r.recordsSynced > 0 || r.cursor !== previous?.[i]?.cursor),
  );
}
