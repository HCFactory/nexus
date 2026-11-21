'use server';

import { requireActiveBusinessCentralScope } from '@/lib/businessCentral/environmentScope';
import { editScope, NO_PERMISSION, type Fail, type Scope } from '@/lib/salesOrders/editScope';
import { cleanNoteBody, errorMessage, withNoteAuthors } from '@/lib/notes/noteHelpers';
import { createServiceClient } from '@/lib/supabase/server';
import type { SalesOrderNoteRow, SalesOrderNoteView } from '@/types/salesOrders';

const NOTES = 'sales_order_notes';
const ORDER_NOT_FOUND = 'Sales order not found.';
const NOTE_NOT_FOUND = 'Note not found.';

async function loadNote(scope: Scope, id: string): Promise<SalesOrderNoteRow | null> {
  const { data, error } = await createServiceClient()
    .from(NOTES)
    .select('*')
    .eq('id', id)
    .eq('organization_id', scope.orgId)
    .eq('bc_connection_id', scope.bcConnectionId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the note: ${error.message}`);
  return (data as SalesOrderNoteRow | null) ?? null;
}

/** Notes on an order, newest first. Empty without permission to view sales orders. */
export async function listSalesOrderNotes(orderId: string): Promise<SalesOrderNoteView[]> {
  let scope: Scope;
  try {
    scope = await requireActiveBusinessCentralScope();
  } catch {
    return []; // no Business Central environment selected
  }
  if (!scope.access.canViewSalesOrders) return [];
  const { data, error } = await createServiceClient()
    .from(NOTES)
    .select('*')
    .eq('sales_order_id', orderId)
    .eq('organization_id', scope.orgId)
    .eq('bc_connection_id', scope.bcConnectionId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Could not load the notes: ${error.message}`);
  return withNoteAuthors((data ?? []) as SalesOrderNoteRow[]);
}

/** Add a note. Allowed in any order status; it is not part of the order's BC sync. */
export async function addSalesOrderNote(
  orderId: string,
  body: string,
): Promise<{ ok: true; note: SalesOrderNoteView } | Fail> {
  try {
    const scope = await editScope();
    if (!scope) return { ok: false, error: NO_PERMISSION };
    const clean = cleanNoteBody(body);
    if ('error' in clean) return { ok: false, error: clean.error };

    const supabase = createServiceClient();
    const { data: order, error: orderError } = await supabase
      .from('sales_orders')
      .select('id')
      .eq('id', orderId)
      .eq('organization_id', scope.orgId)
      .eq('bc_connection_id', scope.bcConnectionId)
      .maybeSingle();
    if (orderError) throw new Error(orderError.message);
    if (!order) return { ok: false, error: ORDER_NOT_FOUND };

    const { data, error } = await supabase
      .from(NOTES)
      .insert({
        organization_id: scope.orgId,
        bc_connection_id: scope.bcConnectionId,
        sales_order_id: orderId,
        body: clean.body,
        created_by: scope.user.id,
      })
      .select('*')
      .single();
    if (error || !data) throw new Error(error?.message ?? 'no row returned');
    const [note] = await withNoteAuthors([data as SalesOrderNoteRow]);
    return { ok: true, note };
  } catch (e) {
    return { ok: false, error: `Could not add the note: ${errorMessage(e)}` };
  }
}

/** Change a note's text. */
export async function updateSalesOrderNote(
  noteId: string,
  body: string,
): Promise<{ ok: true; note: SalesOrderNoteView } | Fail> {
  try {
    const scope = await editScope();
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
    const [note] = await withNoteAuthors([data as SalesOrderNoteRow]);
    return { ok: true, note };
  } catch (e) {
    return { ok: false, error: `Could not save the note: ${errorMessage(e)}` };
  }
}

/** Delete a note. */
export async function deleteSalesOrderNote(noteId: string): Promise<{ ok: true } | Fail> {
  try {
    const scope = await editScope();
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
