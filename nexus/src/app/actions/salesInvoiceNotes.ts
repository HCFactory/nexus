'use server';

import { requireActiveBusinessCentralScope } from '@/lib/businessCentral/environmentScope';
import { cleanNoteBody, errorMessage, NOTE_NOT_FOUND, withNoteAuthors } from '@/lib/notes/noteHelpers';
import { createServiceClient } from '@/lib/supabase/server';
import type { SalesInvoiceNoteRow, SalesInvoiceNoteView } from '@/types/salesOrders';

const NOTES = 'sales_invoice_notes';
const NO_PERMISSION = "You don't have permission to change invoice notes";
const INVOICE_NOT_FOUND = 'Invoice not found.';

type Fail = { ok: false; error: string };
type Scope = Awaited<ReturnType<typeof requireActiveBusinessCentralScope>>;

/** The active scope, or null for someone who can't see receivables (invoice notes follow invoice access). */
async function noteScope(): Promise<Scope | null> {
  const scope = await requireActiveBusinessCentralScope();
  return scope.access.canViewReceivables ? scope : null;
}

async function loadNote(scope: Scope, id: string): Promise<SalesInvoiceNoteRow | null> {
  const { data, error } = await createServiceClient()
    .from(NOTES)
    .select('*')
    .eq('id', id)
    .eq('organization_id', scope.orgId)
    .eq('bc_connection_id', scope.bcConnectionId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the note: ${error.message}`);
  return (data as SalesInvoiceNoteRow | null) ?? null;
}

/** Notes on an invoice, newest first. Empty without permission to view receivables. */
export async function listSalesInvoiceNotes(bcInvoiceId: string): Promise<SalesInvoiceNoteView[]> {
  let scope: Scope | null;
  try {
    scope = await noteScope();
  } catch {
    return []; // no Business Central environment selected
  }
  if (!scope) return [];
  const { data, error } = await createServiceClient()
    .from(NOTES)
    .select('*')
    .eq('bc_invoice_id', bcInvoiceId)
    .eq('organization_id', scope.orgId)
    .eq('bc_connection_id', scope.bcConnectionId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Could not load the notes: ${error.message}`);
  return withNoteAuthors((data ?? []) as SalesInvoiceNoteRow[]);
}

/** Add a note to an invoice of the active environment. Notes stay in Nexus (never sent to BC or Bill.com). */
export async function addSalesInvoiceNote(
  bcInvoiceId: string,
  body: string,
): Promise<{ ok: true; note: SalesInvoiceNoteView } | Fail> {
  try {
    const scope = await noteScope();
    if (!scope) return { ok: false, error: NO_PERMISSION };
    const clean = cleanNoteBody(body);
    if ('error' in clean) return { ok: false, error: clean.error };

    const supabase = createServiceClient();
    const { data: invoice, error: invoiceError } = await supabase
      .from('business_central_sales_invoices')
      .select('bc_invoice_id')
      .eq('bc_invoice_id', bcInvoiceId)
      .eq('organization_id', scope.orgId)
      .eq('bc_connection_id', scope.bcConnectionId)
      .maybeSingle();
    if (invoiceError) throw new Error(invoiceError.message);
    if (!invoice) return { ok: false, error: INVOICE_NOT_FOUND };

    const { data, error } = await supabase
      .from(NOTES)
      .insert({
        organization_id: scope.orgId,
        bc_connection_id: scope.bcConnectionId,
        bc_invoice_id: bcInvoiceId,
        body: clean.body,
        created_by: scope.user.id,
      })
      .select('*')
      .single();
    if (error || !data) throw new Error(error?.message ?? 'no row returned');
    const [note] = await withNoteAuthors([data as SalesInvoiceNoteRow]);
    return { ok: true, note };
  } catch (e) {
    return { ok: false, error: `Could not add the note: ${errorMessage(e)}` };
  }
}

/** Change a note's text. */
export async function updateSalesInvoiceNote(
  noteId: string,
  body: string,
): Promise<{ ok: true; note: SalesInvoiceNoteView } | Fail> {
  try {
    const scope = await noteScope();
    if (!scope) return { ok: false, error: NO_PERMISSION };
    const clean = cleanNoteBody(body);
    if ('error' in clean) return { ok: false, error: clean.error };
    if (!(await loadNote(scope, noteId))) return { ok: false, error: NOTE_NOT_FOUND };

    const { data, error } = await createServiceClient()
      .from(NOTES)
      .update({ body: clean.body, updated_by: scope.user.id, updated_at: new Date().toISOString() })
      .eq('id', noteId)
      .eq('organization_id', scope.orgId)
      .eq('bc_connection_id', scope.bcConnectionId)
      .select('*')
      .single();
    if (error || !data) throw new Error(error?.message ?? 'no row returned');
    const [note] = await withNoteAuthors([data as SalesInvoiceNoteRow]);
    return { ok: true, note };
  } catch (e) {
    return { ok: false, error: `Could not save the note: ${errorMessage(e)}` };
  }
}

/** Delete a note. */
export async function deleteSalesInvoiceNote(noteId: string): Promise<{ ok: true } | Fail> {
  try {
    const scope = await noteScope();
    if (!scope) return { ok: false, error: NO_PERMISSION };
    if (!(await loadNote(scope, noteId))) return { ok: false, error: NOTE_NOT_FOUND };

    const { error } = await createServiceClient()
      .from(NOTES)
      .delete()
      .eq('id', noteId)
      .eq('organization_id', scope.orgId)
      .eq('bc_connection_id', scope.bcConnectionId);
    if (error) throw new Error(error.message);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Could not delete the note: ${errorMessage(e)}` };
  }
}
