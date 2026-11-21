// Saves synced Bill.com payments: the payment (one row per connection and
// Bill.com id) and the invoices it paid, replaced as a set on every save.
import type { SupabaseClient } from '@supabase/supabase-js';

import type { toStoredPayment } from './receivedPayments';

export async function saveReceivedPayments(
  supabase: SupabaseClient,
  orgId: string,
  billcomConnectionId: string,
  rows: ReturnType<typeof toStoredPayment>[],
): Promise<void> {
  if (rows.length === 0) return;
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('billcom_received_payments')
    .upsert(
      rows.map((r) => ({ ...r.payment, organization_id: orgId, billcom_connection_id: billcomConnectionId, synced_at: now })),
      { onConflict: 'billcom_connection_id,billcom_payment_id' },
    )
    .select('id, billcom_payment_id');
  if (error) throw new Error(`Could not save Bill.com payments: ${error.message}`);
  const idOf = new Map(((data ?? []) as { id: string; billcom_payment_id: string }[]).map((p) => [p.billcom_payment_id, p.id]));
  const paymentIds = [...idOf.values()];
  if (paymentIds.length === 0) return;

  const { error: delError } = await supabase.from('billcom_received_payment_invoices').delete().in('payment_id', paymentIds);
  if (delError) throw new Error(`Could not update Bill.com payment invoices: ${delError.message}`);
  const applications = rows.flatMap((r) => {
    const paymentId = idOf.get(r.payment.billcom_payment_id);
    return paymentId
      ? r.applications.map((a) => ({ ...a, organization_id: orgId, billcom_connection_id: billcomConnectionId, payment_id: paymentId }))
      : [];
  });
  if (applications.length === 0) return;
  const { error: insError } = await supabase.from('billcom_received_payment_invoices').insert(applications);
  if (insError) throw new Error(`Could not save Bill.com payment invoices: ${insError.message}`);
}
