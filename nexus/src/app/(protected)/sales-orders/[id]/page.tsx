import { notFound } from 'next/navigation';
import { getSalesOrder, getSalesOrderFormContext, getSalesOrderPriceLines } from '@/app/actions/salesOrders';
import { listSalesOrderNotes } from '@/app/actions/salesOrderNotes';
import { getInvoiceReadiness, resumeInvoiceIfStuck } from '@/app/actions/salesOrderInvoicing';
import { resumeInvoiceChangeIfStuck } from '@/app/actions/salesInvoiceChanges';
import { listShipTos } from '@/app/actions/shipToAddresses';
import { SalesOrderForm } from '@/components/salesOrders/SalesOrderForm';
import { resolveSalesOrderPageAccess, SalesOrderPageNotice } from '../salesOrderPageAccess';

export const dynamic = 'force-dynamic';

export default async function SalesOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await resolveSalesOrderPageAccess();
  if (!gate.ok) return <SalesOrderPageNotice title={gate.title} message={gate.message} />;

  const [found, context] = await Promise.all([getSalesOrder(id), getSalesOrderFormContext()]);
  if (!found) notFound();
  const { order, lines } = found;
  // Ship-tos need customer view permission; without it the picker just lists none.
  // Price lines for this order's customer only (the context carries just the All Customers ones).
  const [shipTos, notes, priceListLines, readiness] = await Promise.all([
    listShipTos(order.customer_number).catch(() => []),
    listSalesOrderNotes(order.id).catch(() => []),
    getSalesOrderPriceLines(order.customer_number).catch(() => context.priceListLines),
    getInvoiceReadiness(order.customer_number),
    resumeInvoiceIfStuck(order.id),
    order.invoice_state === 'changing' ? resumeInvoiceChangeIfStuck(order.id) : undefined,
  ]);

  return (
    <SalesOrderForm
      // A save bumps local_version, which resets the form to the saved order. Sync
      // refreshes (sync state, totals, amounts) keep the version, so unsaved edits survive them. Each invoice
      // step change remounts the (locked) form, since the invoice process does not bump local_version.
      key={`${order.id}:${order.local_version}:${order.invoice_state}`}
      order={order}
      lines={lines}
      context={{ ...context, priceListLines }}
      shipTos={shipTos}
      notes={notes}
      canEdit={gate.access.canEditSalesOrders}
      canSaveShipTo={gate.access.canEditCustomers}
      invoiceBlockedReason={readiness.blockedReason}
    />
  );
}
