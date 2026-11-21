'use client';

import { addSalesInvoiceNote, deleteSalesInvoiceNote, updateSalesInvoiceNote } from '@/app/actions/salesInvoiceNotes';
import { NotesPanel, type NotesActions } from '@/components/salesOrders/NotesPanel';
import type { NoteView } from '@/types/salesOrders';

const INVOICE_ACTIONS: NotesActions = {
  add: addSalesInvoiceNote,
  update: updateSalesInvoiceNote,
  remove: deleteSalesInvoiceNote,
};

/** Notes on a sales invoice: the same panel as sales order notes, saved against the invoice. */
export function InvoiceNotes({ bcInvoiceId, canEdit, initialNotes }: { bcInvoiceId: string; canEdit: boolean; initialNotes: NoteView[] }) {
  return <NotesPanel parentId={bcInvoiceId} canEdit={canEdit} initialNotes={initialNotes} actions={INVOICE_ACTIONS} />;
}
