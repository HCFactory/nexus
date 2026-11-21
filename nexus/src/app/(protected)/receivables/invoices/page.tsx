import { getSalesInvoicesPageData } from '@/app/actions/businessCentralReceivables';
import { SalesInvoicesClient } from '@/components/receivables/SalesInvoicesClient';
import { hawaiiToday } from '@/lib/billcom/paymentDisplay';
import { parseSalesInvoiceListParams } from '@/lib/receivables/salesInvoiceList';

export const dynamic = 'force-dynamic';

// The address holds the search, filters and page (?q=&status=&billcom=&from=&to=&page=);
// the list is searched and paged in the database.
export default async function SalesInvoicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = parseSalesInvoiceListParams(await searchParams);
  const today = hawaiiToday();
  const { invoices, total, billcomStatus, error } = await getSalesInvoicesPageData(params, today);
  return <SalesInvoicesClient invoices={invoices} total={total} params={params} billcomStatus={billcomStatus} today={today} error={error} />;
}
