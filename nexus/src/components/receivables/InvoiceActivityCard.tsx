'use client';

import { useState } from 'react';
import Link from 'next/link';

import type { ActivityEvent } from '@/lib/receivables/invoiceActivity';
import { CARD } from './SalesInvoiceDetail';

const FIRST = 8;

/** "Nov 12, 2026" for whole days; with the time (Hawaii) otherwise. */
const when = (at: string) =>
  at.length <= 10
    ? new Date(`${at}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    : new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Pacific/Honolulu' });

/** What happened to the invoice, newest first. */
export function InvoiceActivityCard({ activity }: { activity: ActivityEvent[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? activity : activity.slice(0, FIRST);
  return (
    <section className={CARD}>
      <h2 className="mb-3 text-sm font-semibold text-foreground">Activity</h2>
      {activity.length === 0 ? (
        <p className="text-sm text-foreground-muted">No activity yet.</p>
      ) : (
        <>
          <ol className="relative space-y-3 border-l border-border pl-4">
            {shown.map((e, i) => (
              <li key={`${e.at}-${e.kind}-${i}`} className="relative">
                <span aria-hidden className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-primary/70 ring-2 ring-surface-raised" />
                <div className="text-xs text-foreground-muted">{when(e.at)}</div>
                <div className="text-sm text-foreground">
                  {e.href ? (
                    <Link href={e.href} className="text-primary hover:underline">
                      {e.title}
                    </Link>
                  ) : (
                    e.title
                  )}
                </div>
                {e.detail && <div className="text-xs text-foreground-muted">{e.detail}</div>}
              </li>
            ))}
          </ol>
          {!all && activity.length > FIRST && (
            <button type="button" onClick={() => setAll(true)} className="mt-3 text-xs text-primary hover:underline">
              Show all {activity.length}
            </button>
          )}
        </>
      )}
    </section>
  );
}
