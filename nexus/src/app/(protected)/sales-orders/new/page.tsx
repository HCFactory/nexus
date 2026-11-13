import { getSalesOrderFormContext } from '@/app/actions/salesOrders';
import { SalesOrderForm } from '@/components/salesOrders/SalesOrderForm';
import { resolveSalesOrderPageAccess, SalesOrderPageNotice } from '../salesOrderPageAccess';

export const dynamic = 'force-dynamic';

export default async function NewSalesOrderPage() {
  const gate = await resolveSalesOrderPageAccess();
  if (!gate.ok) return <SalesOrderPageNotice title={gate.title} message={gate.message} />;
  if (!gate.access.canEditSalesOrders) {
    return <SalesOrderPageNotice title="No access" message="You don't have permission to create sales orders." />;
  }
  const context = await getSalesOrderFormContext();
  return (
    <SalesOrderForm
      order={null}
      lines={[]}
      context={context}
      shipTos={[]}
      canEdit
      canSaveShipTo={gate.access.canEditCustomers}
    />
  );
}
