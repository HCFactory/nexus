import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase, type FakeSupabase, type Row } from '@/test/fakeSupabase';

const mocks = vi.hoisted(() => ({ requireScope: vi.fn(), createServiceClient: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/businessCentral/environmentScope', () => ({ requireActiveBusinessCentralScope: mocks.requireScope }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.createServiceClient }));

import { addSalesInvoiceNote, deleteSalesInvoiceNote, listSalesInvoiceNotes, updateSalesInvoiceNote } from './salesInvoiceNotes';

const NO_PERMISSION = "You don't have permission to change invoice notes";
const scope = (canViewReceivables = true) => ({
  orgId: 'org-1',
  bcConnectionId: 'conn-1',
  user: { id: 'user-1' },
  access: { canViewReceivables },
});
const invoice = (id: string, extra: Row = {}): Row => ({ id: `row-${id}`, organization_id: 'org-1', bc_connection_id: 'conn-1', bc_invoice_id: id, ...extra });
const note = (id: string, extra: Row = {}): Row => ({
  id, organization_id: 'org-1', bc_connection_id: 'conn-1', bc_invoice_id: 'inv-1', body: 'Promised to pay Friday',
  created_by: 'user-1', created_at: '2026-11-01T10:00:00.000Z', updated_by: null, updated_at: '2026-11-01T10:00:00.000Z', ...extra,
});

let db: FakeSupabase;
function setup(tables: Record<string, Row[]> = {}) {
  db = fakeSupabase({
    business_central_sales_invoices: [invoice('inv-1')],
    sales_invoice_notes: [],
    users: [{ id: 'user-1', display_name: 'Frank' }],
    ...tables,
  });
  mocks.createServiceClient.mockReturnValue(db.client);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireScope.mockResolvedValue(scope());
  setup();
});

describe('listSalesInvoiceNotes', () => {
  it('returns this invoice’s notes newest first with author names, only for the active environment', async () => {
    setup({
      sales_invoice_notes: [
        note('n1', { created_at: '2026-11-01T10:00:00.000Z' }),
        note('n2', { created_at: '2026-11-02T10:00:00.000Z', created_by: 'gone' }),
        note('n3', { bc_invoice_id: 'other' }),
        note('n4', { organization_id: 'org-2' }),
        note('n5', { bc_connection_id: 'conn-2' }),
      ],
    });
    const notes = await listSalesInvoiceNotes('inv-1');
    expect(notes.map((n) => [n.id, n.author_name])).toEqual([['n2', ''], ['n1', 'Frank']]);
  });

  it('returns nothing without permission to view receivables', async () => {
    mocks.requireScope.mockResolvedValue(scope(false));
    setup({ sales_invoice_notes: [note('n1')] });
    expect(await listSalesInvoiceNotes('inv-1')).toEqual([]);
  });
});

describe('addSalesInvoiceNote', () => {
  it('adds a trimmed note stamped with the user and the environment', async () => {
    const res = await addSalesInvoiceNote('inv-1', '  Called, will pay Friday  ');
    expect(res).toMatchObject({ ok: true, note: { body: 'Called, will pay Friday', author_name: 'Frank', created_by: 'user-1' } });
    expect(db.tables.sales_invoice_notes[0]).toMatchObject({
      organization_id: 'org-1', bc_connection_id: 'conn-1', bc_invoice_id: 'inv-1', body: 'Called, will pay Friday', created_by: 'user-1',
    });
  });

  it.each([['empty', '   ', 'Write something first.'], ['too long', 'x'.repeat(4001), 'Notes can be up to 4000 characters.']])(
    'refuses a note that is %s',
    async (_n, body, error) => {
      expect(await addSalesInvoiceNote('inv-1', body)).toEqual({ ok: false, error });
      expect(db.tables.sales_invoice_notes).toHaveLength(0);
    },
  );

  it('refuses an invoice that is not in this environment', async () => {
    expect(await addSalesInvoiceNote('nope', 'hi')).toEqual({ ok: false, error: 'Invoice not found.' });
    setup({ business_central_sales_invoices: [invoice('inv-1', { bc_connection_id: 'conn-2' })] });
    expect(await addSalesInvoiceNote('inv-1', 'hi')).toEqual({ ok: false, error: 'Invoice not found.' });
  });

  it('refuses without permission', async () => {
    mocks.requireScope.mockResolvedValue(scope(false));
    expect(await addSalesInvoiceNote('inv-1', 'hi')).toEqual({ ok: false, error: NO_PERMISSION });
  });
});

describe('updateSalesInvoiceNote', () => {
  it('changes the text and stamps who and when', async () => {
    setup({ sales_invoice_notes: [note('n1')] });
    const res = await updateSalesInvoiceNote('n1', ' Paid by check ');
    expect(res).toMatchObject({ ok: true, note: { id: 'n1', body: 'Paid by check' } });
    expect(db.tables.sales_invoice_notes[0]).toMatchObject({ body: 'Paid by check', updated_by: 'user-1' });
  });

  it('cannot reach another organization’s or environment’s note', async () => {
    setup({ sales_invoice_notes: [note('n1', { organization_id: 'org-2' }), note('n2', { bc_connection_id: 'conn-2' })] });
    expect(await updateSalesInvoiceNote('n1', 'x')).toEqual({ ok: false, error: 'Note not found.' });
    expect(await updateSalesInvoiceNote('n2', 'x')).toEqual({ ok: false, error: 'Note not found.' });
  });

  it('refuses without permission', async () => {
    mocks.requireScope.mockResolvedValue(scope(false));
    setup({ sales_invoice_notes: [note('n1')] });
    expect(await updateSalesInvoiceNote('n1', 'x')).toEqual({ ok: false, error: NO_PERMISSION });
  });
});

describe('deleteSalesInvoiceNote', () => {
  it('deletes the note', async () => {
    setup({ sales_invoice_notes: [note('n1')] });
    expect(await deleteSalesInvoiceNote('n1')).toEqual({ ok: true });
    expect(db.tables.sales_invoice_notes).toHaveLength(0);
  });

  it('cannot delete another environment’s note, or without permission', async () => {
    setup({ sales_invoice_notes: [note('n1', { bc_connection_id: 'conn-2' })] });
    expect(await deleteSalesInvoiceNote('n1')).toEqual({ ok: false, error: 'Note not found.' });
    mocks.requireScope.mockResolvedValue(scope(false));
    expect(await deleteSalesInvoiceNote('n1')).toEqual({ ok: false, error: NO_PERMISSION });
    expect(db.tables.sales_invoice_notes).toHaveLength(1);
  });
});
