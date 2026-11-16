import { Suspense } from 'react';
import { notFound } from 'next/navigation';

import { getSalesInvoiceBillcomPanel, getSalesInvoicePage } from '@/app/actions/salesInvoicePage';
import { BillcomInvoicePanel } from '@/components/receivables/BillcomInvoicePanel';
import { SalesInvoiceDetail } from '@/components/receivables/SalesInvoiceDetail';

export const dynamic = 'force-dynamic';

/** The live Bill.com read, streamed in so a slow Bill.com never holds up the page. */
async function BillcomSide({ bcInvoiceId }: { bcInvoiceId: string }) {
  return <BillcomInvoicePanel panel={await getSalesInvoiceBillcomPanel(bcInvoiceId)} />;
}

export default async function SalesInvoicePage({ params }: { params: Promise<{ bcInvoiceId: string }> }) {
  const { bcInvoiceId } = await params;
  const data = await getSalesInvoicePage(bcInvoiceId);
  if (!data) notFound();
  return (
    <SalesInvoiceDetail
      invoice={data.invoice}
      lines={data.lines}
      salesOrder={data.salesOrder}
      billcom={
        <Suspense fallback={<p className="text-sm text-foreground-muted">Loading Bill.com…</p>}>
          <BillcomSide bcInvoiceId={bcInvoiceId} />
        </Suspense>
      }
    />
  );
}
