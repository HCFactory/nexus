import { getSalesInvoicesPageData } from '@/app/actions/businessCentralReceivables';
import { SalesInvoicesClient } from '@/components/receivables/SalesInvoicesClient';

export const dynamic = 'force-dynamic';

export default async function SalesInvoicesPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const { q } = await searchParams;
  const { invoices } = await getSalesInvoicesPageData();
  return <SalesInvoicesClient invoices={invoices} initialSearch={Array.isArray(q) ? q[0] : q} />;
}
