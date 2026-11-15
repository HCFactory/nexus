'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { formatMoney } from '@/lib/format';
import { autoInvoiceNumber } from '@/lib/salesOrders/orderRules';
import type { SalesOrderListRow } from '@/types/salesOrders';
import { STATUS_CLASSES, STATUS_LABELS } from './StatusSelect';
import { SyncBadge } from './SyncBadge';

interface Props {
  orders: SalesOrderListRow[];
  canEdit: boolean;
}

const noop = () => undefined;

export function SalesOrdersList({ orders, canEdit }: Props) {
  const router = useRouter();
  const [attentionOnly, setAttentionOnly] = useState(false);

  const attentionCount = useMemo(
    () => orders.filter((o) => o.sync_state === 'failed' || o.sync_state === 'conflict').length,
    [orders],
  );
  const shown = useMemo(
    () => (attentionOnly ? orders.filter((o) => o.sync_state === 'failed' || o.sync_state === 'conflict') : orders),
    [orders, attentionOnly],
  );

  const open = (id: string) => router.push(`/sales-orders/${id}`);

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Sales orders</h1>
          <p className="mt-1 text-xs text-foreground-subtle">
            {orders.length} order{orders.length === 1 ? '' : 's'}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant={attentionOnly ? 'default' : 'outline'}
          aria-pressed={attentionOnly}
          onClick={() => setAttentionOnly((v) => !v)}
        >
          Needs attention ({attentionCount})
        </Button>
        {canEdit && (
          <Button asChild size="sm">
            <Link href="/sales-orders/new">
              <Plus className="size-4" />
              New sales order
            </Link>
          </Button>
        )}
      </header>

      <div className="p-3 lg:p-4">
        <div className="overflow-x-auto rounded-xl border border-border bg-surface-raised card-shadow">
          {shown.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-foreground-muted">
              {attentionOnly ? 'No orders need attention.' : 'No sales orders yet.'}
            </p>
          ) : (
            <table className="min-w-full divide-y divide-border text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-foreground-subtle">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Order #</th>
                  <th className="px-4 py-2.5 font-medium">Invoice #</th>
                  <th className="px-4 py-2.5 font-medium">Customer</th>
                  <th className="px-4 py-2.5 font-medium">Customer PO</th>
                  <th className="px-4 py-2.5 font-medium">Order date</th>
                  <th className="px-4 py-2.5 text-right font-medium">Total</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Sync</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shown.map((o) => (
                  <tr
                    key={o.id}
                    tabIndex={0}
                    onClick={() => open(o.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') open(o.id);
                    }}
                    className="cursor-pointer transition-colors hover:bg-surface focus-visible:bg-surface"
                  >
                    <td className="px-4 py-2.5 font-mono text-xs text-foreground-muted">
                      {o.bc_order_number ?? 'Not yet in BC'}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-foreground-muted">{o.invoice_number ?? (autoInvoiceNumber(o.bc_order_number, o.customer_po) || '—')}</td>
                    <td className="px-4 py-2.5 font-medium text-foreground">{o.customer_name}</td>
                    <td className="px-4 py-2.5 text-foreground-muted">{o.customer_po || '—'}</td>
                    <td className="px-4 py-2.5 text-foreground-muted">{o.order_date}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-foreground">
                      {formatMoney(o.total_incl_tax, null)}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_CLASSES[o.status]}`}
                      >
                        {STATUS_LABELS[o.status]}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <SyncBadge state={o.sync_state} error={o.sync_error} canAct={false} onRetry={noop} onOverwrite={noop} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
