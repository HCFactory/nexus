import { getCustomersPageData } from '@/app/actions/businessCentralReceivables';
import { getCustomerEditContext } from '@/app/actions/customerEditing';
import { CustomersClient } from '@/components/customers/CustomersClient';

export const dynamic = 'force-dynamic';

type CustomersPageSearchParams = Promise<{
  search?: string | string[];
}>;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams?: CustomersPageSearchParams;
}) {
  const params = searchParams ? await searchParams : undefined;
  const [{ customers, canSync }, edit] = await Promise.all([getCustomersPageData(), getCustomerEditContext()]);
  return (
    <CustomersClient
      customers={customers}
      canSync={canSync}
      edit={edit}
      initialSearch={firstParam(params?.search)}
    />
  );
}
