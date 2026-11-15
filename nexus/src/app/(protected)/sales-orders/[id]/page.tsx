import { notFound } from 'next/navigation';
import { getSalesOrder, getSalesOrderFormContext } from '@/app/actions/salesOrders';
import { listSalesOrderNotes } from '@/app/actions/salesOrderNotes';
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
  const [shipTos, notes] = await Promise.all([
    listShipTos(order.customer_number).catch(() => []),
    listSalesOrderNotes(order.id),
  ]);

  return (
    <SalesOrderForm
      // A save bumps local_version, which resets the form to the saved order. Sync
      // refreshes (sync state, totals, amounts) keep the version, so unsaved edits survive them.
      key={`${order.id}:${order.local_version}`}
      order={order}
      lines={lines}
      context={context}
      shipTos={shipTos}
      notes={notes}
      canEdit={gate.access.canEditSalesOrders}
      canSaveShipTo={gate.access.canEditCustomers}
    />
  );
}
