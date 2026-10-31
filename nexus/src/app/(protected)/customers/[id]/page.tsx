import { notFound } from 'next/navigation';
import { getCustomerDetail } from '@/app/actions/businessCentralReceivables';
import { getCustomerEditContext } from '@/app/actions/customerEditing';
import { getBillcomCustomerView } from '@/app/actions/billcomCustomers';
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
  return <CustomerDetail {...detail} edit={edit} billcom={billcom} />;
}
