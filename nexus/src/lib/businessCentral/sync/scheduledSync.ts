import type { SyncEntityResult } from '@/lib/businessCentral/syncRunner';

import { shouldSyncAgain } from './shouldSyncAgain';
import { SyncInProgressError } from './syncRunsError';

export interface ScheduledSyncOutcome {
  connectionId: string;
  rounds: number;
  status: string;
}

/**
 * The automatic sync for each environment marked "Sync automatically".
 * light: one round. full: rounds while it keeps moving, until complete or out
 * of time (the next schedule continues from where it stopped). One
 * environment's failure never stops the others; a held lock is skipped.
 */
export async function runScheduledSync(o: {
  kind: 'light' | 'full';
  connections: string[];
  round: (connectionId: string) => Promise<SyncEntityResult[]>;
  nowMs: () => number;
  budgetMs: number;
}): Promise<ScheduledSyncOutcome[]> {
  const started = o.nowMs();
  const out: ScheduledSyncOutcome[] = [];
  for (const connectionId of o.connections) {
    let rounds = 0;
    let previous: SyncEntityResult[] | null = null;
    try {
      for (;;) {
        const results = await o.round(connectionId);
        rounds++;
        if (o.kind === 'light' || !shouldSyncAgain(results, previous) || o.nowMs() - started >= o.budgetMs) break;
        previous = results;
      }
      out.push({ connectionId, rounds, status: 'ok' });
    } catch (e) {
      out.push({
        connectionId,
        rounds,
        status: e instanceof SyncInProgressError ? 'skipped (another sync is running)' : `error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return out;
}
