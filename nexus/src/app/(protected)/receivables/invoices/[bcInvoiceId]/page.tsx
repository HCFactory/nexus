import { Suspense } from 'react';
import { notFound } from 'next/navigation';

import { getSalesInvoiceBillcomPanel, getSalesInvoicePage, type BillcomPanelInput } from '@/lib/receivables/salesInvoicePage';
import { getInvoiceChargeView } from '@/app/actions/cardPayments';
import { requireOrganizationContext } from '@/lib/auth/currentUserAccess';
import { loadChargePanel } from '@/lib/stripe/chargePanelLoad';
import { CardChargePanel } from '@/components/receivables/CardChargePanel';
import { BillcomInvoicePanel } from '@/components/receivables/BillcomInvoicePanel';
import { InvoiceChangesCard } from '@/components/receivables/InvoiceChangesCard';
import { SalesInvoiceDetail } from '@/components/receivables/SalesInvoiceDetail';

export const dynamic = 'force-dynamic';

/** The live Bill.com read, streamed in so a slow Bill.com never holds up the page. */
async function BillcomSide({ input }: { input: BillcomPanelInput }) {
  return <BillcomInvoicePanel panel={await getSalesInvoiceBillcomPanel(input)} />;
}

/** The Charge card panel, streamed in beside the Bill.com one. Hidden from staff who cannot charge unless card payments exist. */
async function CardChargeSide({ bcInvoiceId, invoiceNumber }: { bcInvoiceId: string; invoiceNumber: string }) {
  const load = await loadChargePanel(bcInvoiceId, {
    canCharge: async () => Boolean((await requireOrganizationContext()).access.canChargeSavedCards),
    view: getInvoiceChargeView,
  });
  if (load.kind === 'hidden') return null;
  if (load.kind === 'error') return <p className="text-sm text-foreground-muted">Card payments couldn&apos;t be loaded right now.</p>;
  return <CardChargePanel bcInvoiceId={bcInvoiceId} invoiceNumber={invoiceNumber} canCharge={load.canCharge} {...load.view} />;
}

export default async function SalesInvoicePage({ params }: { params: Promise<{ bcInvoiceId: string }> }) {
  const { bcInvoiceId } = await params;
  const data = await getSalesInvoicePage(bcInvoiceId);
  if (!data) notFound();
  return (
    <SalesInvoiceDetail
      invoice={data.invoice}
      lines={data.lines}
      linesError={data.linesError}
      salesOrder={data.salesOrder}
      replacedBy={data.replacedBy}
      changes={<InvoiceChangesCard changes={data.changes} />}
      cardCharge={
        <Suspense fallback={<p className="text-sm text-foreground-muted">Loading card payments…</p>}>
          <CardChargeSide
            bcInvoiceId={data.invoice.bc_invoice_id}
            invoiceNumber={data.invoice.external_document_number || data.invoice.bc_invoice_number || data.invoice.bc_invoice_id}
          />
        </Suspense>
      }
      billcom={
        <Suspense fallback={<p className="text-sm text-foreground-muted">Loading Bill.com…</p>}>
          {/* The details already loaded: the panel must not re-read the invoice (memoized reads). */}
          <BillcomSide
            input={{
              customerNumber: data.invoice.customer_number,
              invoiceNumbers: [data.invoice.external_document_number ?? '', data.invoice.bc_invoice_number ?? ''],
              billcomInvoiceId: data.salesOrder?.billcomInvoiceId ?? null,
            }}
          />
        </Suspense>
      }
    />
  );
}
