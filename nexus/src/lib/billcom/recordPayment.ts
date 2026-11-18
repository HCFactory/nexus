import type { BillcomClient } from './client';

export interface RecordCardPaymentInput {
  billcomInvoiceId: string;
  customerId: string;
  amount: number;
  /** YYYY-MM-DD */
  paymentDate: string;
  description: string;
}

/**
 * Records a card payment taken outside Bill.com (Stripe) against a Bill.com
 * invoice. Only ids, the amount and a reference are sent, never card data.
 * Bill.com errors propagate unchanged.
 */
export async function recordBillcomCardPayment(
  client: BillcomClient,
  input: RecordCardPaymentInput,
): Promise<{ paymentId: string | null }> {
  // Bill.com requires the payment total at the top level as well as per invoice;
  // they are equal here, so nothing is left unapplied as an overpayment.
  const amount = Math.round(input.amount * 100) / 100;
  const res = await client.request<{ id?: string }>('/v3/invoices/record-payment', {
    method: 'POST',
    body: JSON.stringify({
      amount,
      customerId: input.customerId,
      paymentDate: input.paymentDate,
      paymentType: 'CREDIT_CARD',
      description: input.description,
      invoices: [{ id: input.billcomInvoiceId, amount }],
    }),
  });
  return { paymentId: res?.id ?? null };
}
