import { notFound } from 'next/navigation';

import { PaymentDetailView } from '@/components/receivables/PaymentDetailView';
import { getBillcomPaymentPage } from '@/lib/receivables/salesInvoicePage';

export const dynamic = 'force-dynamic';

/** A Bill.com payment received: how it was paid and the invoices it paid. */
export default async function PaymentPage({ params }: { params: Promise<{ paymentId: string }> }) {
  const { paymentId } = await params;
  const detail = await getBillcomPaymentPage(decodeURIComponent(paymentId));
  if (!detail) notFound();
  return <PaymentDetailView detail={detail} />;
}
