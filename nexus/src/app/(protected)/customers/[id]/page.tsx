import { notFound } from 'next/navigation';
import { getCustomerDetail } from '@/app/actions/businessCentralReceivables';
import { getCustomerEditContext } from '@/app/actions/customerEditing';
import { getBillcomCustomerView } from '@/app/actions/billcomCustomers';
import { getSelectOptions } from '@/app/actions/customerReferenceLists';
import { listShipTos } from '@/app/actions/shipToAddresses';
import { CustomerDetail } from '@/components/customers/CustomerDetail';

export const dynamic = 'force-dynamic';

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [detail, edit] = await Promise.all([getCustomerDetail(id), getCustomerEditContext()]);
  if (!detail) notFound();
  const number = detail.customer.bc_customer_number;
  const billcom = number ? await getBillcomCustomerView(number) : undefined;
  // No BC environment selected makes these throw; the page should still render.
  const [shipTos, taxAreas, locations, shipmentMethods] = await Promise.all([
    number ? listShipTos(number).catch(() => []) : [],
    getSelectOptions('taxAreas').catch(() => []),
    getSelectOptions('locations').catch(() => []),
    getSelectOptions('shipmentMethods').catch(() => []),
  ]);
  return (
    <CustomerDetail
      {...detail}
      edit={edit}
      billcom={billcom}
      shipTos={shipTos}
      shipToOptions={{ taxAreas, locations, shipmentMethods }}
    />
  );
}
