import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase, type FakeSupabase, type Row } from '@/test/fakeSupabase';

const mocks = vi.hoisted(() => ({
  requireScope: vi.fn(),
  createServiceClient: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/businessCentral/environmentScope', () => ({ requireActiveBusinessCentralScope: mocks.requireScope }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.createServiceClient }));

import { addSalesOrderNote, deleteSalesOrderNote, listSalesOrderNotes, updateSalesOrderNote } from './salesOrderNotes';

const NO_PERMISSION = "You don't have permission to change sales orders";

const scope = (canEditSalesOrders = true, canViewSalesOrders = true) => ({
  orgId: 'org-1',
  bcConnectionId: 'conn-1',
  user: { id: 'user-1' },
  access: { canEditSalesOrders, canViewSalesOrders },
});

const order = (id: string, extra: Row = {}): Row => ({
  id, organization_id: 'org-1', bc_connection_id: 'conn-1', status: 'draft', ...extra,
});
const note = (id: string, extra: Row = {}): Row => ({
  id, organization_id: 'org-1', bc_connection_id: 'conn-1', sales_order_id: 'o1', body: 'Call first',
  created_by: 'user-1', created_at: '2026-11-01T10:00:00.000Z', updated_by: null, updated_at: '2026-11-01T10:00:00.000Z', ...extra,
});

let db: FakeSupabase;
function setup(tables: Record<string, Row[]> = {}) {
  db = fakeSupabase({
    sales_orders: [order('o1')],
    sales_order_notes: [],
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

describe('listSalesOrderNotes', () => {
  it('returns notes newest first with author names, blank for a deleted user', async () => {
    setup({
      sales_order_notes: [
        note('n1', { created_at: '2026-11-01T10:00:00.000Z' }),
        note('n2', { created_at: '2026-11-02T10:00:00.000Z', created_by: 'gone' }),
        note('n3', { sales_order_id: 'other' }),
        note('n4', { organization_id: 'org-2' }),
      ],
    });
    const notes = await listSalesOrderNotes('o1');
    expect(notes.map((n) => [n.id, n.author_name])).toEqual([['n2', ''], ['n1', 'Frank']]);
  });

  it('returns nothing without view permission', async () => {
    mocks.requireScope.mockResolvedValue(scope(true, false));
    setup({ sales_order_notes: [note('n1')] });
    expect(await listSalesOrderNotes('o1')).toEqual([]);
  });
});

describe('addSalesOrderNote', () => {
  it('adds a trimmed note stamped with the user', async () => {
    const res = await addSalesOrderNote('o1', '  Ship Friday  ');
    expect(res).toMatchObject({ ok: true, note: { body: 'Ship Friday', author_name: 'Frank', created_by: 'user-1' } });
    expect(db.tables.sales_order_notes[0]).toMatchObject({
      organization_id: 'org-1', bc_connection_id: 'conn-1', sales_order_id: 'o1', body: 'Ship Friday', created_by: 'user-1',
    });
  });

  it('works on a Final order', async () => {
    setup({ sales_orders: [order('o1', { status: 'final' })] });
    expect(await addSalesOrderNote('o1', 'Still fine')).toMatchObject({ ok: true });
  });

  it('rejects an empty or too-long body', async () => {
    expect(await addSalesOrderNote('o1', '   ')).toEqual({ ok: false, error: 'Write something first.' });
    expect(await addSalesOrderNote('o1', 'x'.repeat(4001))).toEqual({ ok: false, error: 'Notes can be up to 4000 characters.' });
    expect(db.tables.sales_order_notes).toHaveLength(0);
  });

  it('rejects an order in another org or connection', async () => {
    setup({ sales_orders: [order('o1', { organization_id: 'org-2' })] });
    expect(await addSalesOrderNote('o1', 'hi')).toEqual({ ok: false, error: 'Sales order not found.' });
    setup({ sales_orders: [order('o1', { bc_connection_id: 'conn-2' })] });
    expect(await addSalesOrderNote('o1', 'hi')).toEqual({ ok: false, error: 'Sales order not found.' });
  });

  it('rejects without edit permission', async () => {
    mocks.requireScope.mockResolvedValue(scope(false));
    expect(await addSalesOrderNote('o1', 'hi')).toEqual({ ok: false, error: NO_PERMISSION });
  });
});

describe('updateSalesOrderNote', () => {
  it('updates the body and stamps updated_by / updated_at', async () => {
    setup({ sales_order_notes: [note('n1')] });
    const res = await updateSalesOrderNote('n1', ' New text ');
    expect(res).toMatchObject({ ok: true, note: { id: 'n1', body: 'New text', author_name: 'Frank', updated_by: 'user-1' } });
    const row = db.tables.sales_order_notes[0];
    expect(row.body).toBe('New text');
    expect(row.updated_by).toBe('user-1');
    expect(String(row.updated_at) > String(row.created_at)).toBe(true);
  });

  it('rejects an empty body and a note in another org', async () => {
    setup({ sales_order_notes: [note('n1'), note('n2', { organization_id: 'org-2' })] });
    expect(await updateSalesOrderNote('n1', '')).toEqual({ ok: false, error: 'Write something first.' });
    expect(await updateSalesOrderNote('n2', 'hi')).toEqual({ ok: false, error: 'Note not found.' });
    expect(db.tables.sales_order_notes[1].body).toBe('Call first');
  });

  it('rejects without edit permission', async () => {
    mocks.requireScope.mockResolvedValue(scope(false));
    setup({ sales_order_notes: [note('n1')] });
    expect(await updateSalesOrderNote('n1', 'hi')).toEqual({ ok: false, error: NO_PERMISSION });
  });
});

describe('deleteSalesOrderNote', () => {
  it('deletes a note', async () => {
    setup({ sales_order_notes: [note('n1')] });
    expect(await deleteSalesOrderNote('n1')).toEqual({ ok: true });
    expect(db.tables.sales_order_notes).toHaveLength(0);
  });

  it('rejects a note in another org and a missing permission', async () => {
    setup({ sales_order_notes: [note('n2', { bc_connection_id: 'conn-2' })] });
    expect(await deleteSalesOrderNote('n2')).toEqual({ ok: false, error: 'Note not found.' });
    expect(db.tables.sales_order_notes).toHaveLength(1);
    mocks.requireScope.mockResolvedValue(scope(false));
    expect(await deleteSalesOrderNote('n2')).toEqual({ ok: false, error: NO_PERMISSION });
  });
});
