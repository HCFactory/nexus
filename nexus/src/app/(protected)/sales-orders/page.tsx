import { listSalesOrders } from '@/app/actions/salesOrders';
import { SalesOrdersList } from '@/components/salesOrders/SalesOrdersList';
import { resolveSalesOrderPageAccess, SalesOrderPageNotice } from './salesOrderPageAccess';

export const dynamic = 'force-dynamic';

export default async function SalesOrdersPage() {
  const gate = await resolveSalesOrderPageAccess();
  if (!gate.ok) return <SalesOrderPageNotice title={gate.title} message={gate.message} />;
  const orders = await listSalesOrders();
  return <SalesOrdersList orders={orders} canEdit={gate.access.canEditSalesOrders} />;
}
