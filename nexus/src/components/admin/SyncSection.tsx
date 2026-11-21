'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { syncBusinessCentralReceivables, syncCustomersLight } from '@/app/actions/businessCentralReceivables';
import { syncAllCustomerLists } from '@/app/actions/customerReferenceLists';
import type { SyncOverview, SyncRunSummary } from '@/app/actions/syncAdmin';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { shouldSyncAgain } from '@/lib/businessCentral/sync/shouldSyncAgain';
import type { SyncEntityResult } from '@/lib/businessCentral/syncRunner';
import { formatHSTShort } from '@/lib/utils';

type RowKey = 'full' | 'lists' | 'light';
type Part = { entityType: string; recordsSynced: number; complete: boolean; cursor?: string | null; error: string | null };

const MAX_ROUNDS = 200;

const ROWS: { key: RowKey; name: string; what: string; schedule: string | null }[] = [
  {
    key: 'full',
    name: 'Customers & Receivables',
    what: 'Customers, card fields, ship-to addresses, sales invoices and lines, customer ledger entries, price lists, Bill.com payment status',
    schedule: 'every 2 hours',
  },
  {
    key: 'lists',
    name: 'Customer lists',
    what: 'Payment terms, price groups, tax areas and details, locations, posting groups, shipment methods, number series, customer templates',
    schedule: null,
  },
  {
    key: 'light',
    name: 'Customers (quick)',
    what: 'New and changed customers, card fields, ship-to addresses (also on the Customers page)',
    schedule: 'every 15 minutes',
  },
];

function LastRun({ run }: { run: SyncRunSummary | null }) {
  if (!run) return <span className="text-foreground-subtle">Never</span>;
  const when = formatHSTShort(run.finishedAt ?? run.startedAt);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span>{when}</span>
        <span className="text-foreground-subtle">· {run.trigger === 'scheduled' ? 'automatic' : 'manual'}</span>
        {run.unfinished ? (
          <Badge variant="destructive">Did not finish</Badge>
        ) : run.finishedAt === null ? (
          <Badge variant="warning">In progress</Badge>
        ) : run.complete ? (
          <Badge variant="success">Complete</Badge>
        ) : (
          <Badge variant="warning">Incomplete</Badge>
        )}
      </div>
      {run.error && <p className="text-xs text-destructive">{run.error}</p>}
    </div>
  );
}

/** Admin → Sync: the syncs for the active Business Central environment. */
export function SyncSection({ overview }: { overview: SyncOverview | null }) {
  const router = useRouter();
  const [running, setRunning] = useState<RowKey | null>(null);
  const [round, setRound] = useState(0);
  const [outcome, setOutcome] = useState<Partial<Record<RowKey, { errors: string[]; message?: string }>>>({});
  const stop = useRef(false);
  const [stopping, setStopping] = useState(false);

  if (!overview) {
    return <p className="text-sm text-foreground-muted">Select a Business Central environment to see its syncs.</p>;
  }

  const runRounds = async (action: () => Promise<SyncEntityResult[]>): Promise<Part[]> => {
    let previous: SyncEntityResult[] | null = null;
    let results: SyncEntityResult[] = [];
    for (let i = 1; i <= MAX_ROUNDS; i++) {
      setRound(i);
      results = await action();
      if (stop.current || !shouldSyncAgain(results, previous)) break;
      previous = results;
    }
    return results;
  };

  const run = async (key: RowKey) => {
    setRunning(key);
    setRound(1);
    stop.current = false;
    setStopping(false);
    try {
      let parts: Part[];
      if (key === 'lists') {
        const res = await syncAllCustomerLists();
        if (!res.ok) {
          setOutcome((o) => ({ ...o, [key]: { errors: [], message: res.error } }));
          return;
        }
        parts = res.results;
      } else {
        parts = await runRounds(key === 'full' ? syncBusinessCentralReceivables : syncCustomersLight);
      }
      setOutcome((o) => ({ ...o, [key]: { errors: parts.filter((p) => p.error).map((p) => `${p.entityType}: ${p.error}`) } }));
    } catch (e) {
      setOutcome((o) => ({ ...o, [key]: { errors: [], message: e instanceof Error ? e.message : 'Sync failed' } }));
    } finally {
      setRunning(null);
      router.refresh();
    }
  };

  return (
    // On a phone the table scrolls sideways inside its box rather than squashing or being cut off.
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="w-full min-w-[44rem] text-sm">
        <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-foreground-subtle">
          <tr>
            <th className="px-4 py-3 font-medium">Sync</th>
            <th className="px-4 py-3 font-medium">Schedule</th>
            <th className="px-4 py-3 font-medium">Last run</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {ROWS.map((r) => {
            const out = outcome[r.key];
            return (
              <tr key={r.key} aria-label={r.name}>
                <td className="px-4 py-3 align-top">
                  <p className="font-medium text-foreground">{r.name}</p>
                  <p className="mt-0.5 text-xs text-foreground-subtle">{r.what}</p>
                </td>
                <td className="px-4 py-3 align-top text-foreground-muted">
                  {r.schedule === null
                    ? 'Manual only'
                    : overview.autoSync
                      ? `Automatic, ${r.schedule}`
                      : `Not automatic in ${overview.environment || 'this environment'}`}
                </td>
                <td className="px-4 py-3 align-top text-foreground-muted">
                  <LastRun run={overview.runs[r.key]} />
                  {out?.message && <p className="mt-1 text-xs text-destructive">{out.message}</p>}
                  {out?.errors.map((e) => (
                    <p key={e} className="mt-1 text-xs text-destructive">{e}</p>
                  ))}
                </td>
                <td className="px-4 py-3 text-right align-top">
                  {running === r.key ? (
                    <div className="flex items-center justify-end gap-2 text-xs text-foreground-subtle">
                      {r.key === 'lists' ? 'Syncing…' : stopping ? 'Stopping…' : `Round ${round}`}
                      {r.key !== 'lists' && !stopping && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            stop.current = true;
                            setStopping(true);
                          }}
                        >
                          Stop
                        </Button>
                      )}
                    </div>
                  ) : (
                    <Button type="button" variant="outline" size="sm" disabled={running !== null} onClick={() => void run(r.key)}>
                      Sync now
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
