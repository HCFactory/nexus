import { notFound } from 'next/navigation';
import { getCustomerDetail } from '@/app/actions/businessCentralReceivables';
import { getCustomerEditContext } from '@/app/actions/customerEditing';
import { getBillcomCustomerView } from '@/app/actions/billcomCustomers';
import { getSelectOptions } from '@/app/actions/customerReferenceLists';
import { getCustomerCardView } from '@/app/actions/customerCards';
import { listShipTos } from '@/app/actions/shipToAddresses';
import { CustomerDetail } from '@/components/customers/CustomerDetail';
import { NOTE_PARAM } from '@/components/customers/createdCustomerHref';

export const dynamic = 'force-dynamic';

export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ [NOTE_PARAM]?: string | string[] }>;
}) {
  const { id } = await params;
  const rawNote = (await searchParams)?.[NOTE_PARAM];
  const initialNotice = (Array.isArray(rawNote) ? rawNote[0] : rawNote)?.slice(0, 500) || undefined;
  const [detail, edit] = await Promise.all([getCustomerDetail(id), getCustomerEditContext()]);
  if (!detail) notFound();
  const number = detail.customer.bc_customer_number;
  const billcom = number ? await getBillcomCustomerView(number) : undefined;
  // No BC environment selected makes these throw; the page should still render.
  // A card lookup failure must not take the customer page down.
  const cardView = number ? await getCustomerCardView(number).catch(() => undefined) : undefined;
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
      cardView={cardView}
      shipTos={shipTos}
      shipToOptions={{ taxAreas, locations, shipmentMethods }}
      initialNotice={initialNotice}
    />
  );
}
