import { describe, expect, it, vi } from 'vitest';
import { fakeSupabase } from '@/test/fakeSupabase';
import type { ReferenceTransport } from './customerReferences/transport';
import { ITEM_CARD_SOURCE, refreshItemSalesBlocked } from './itemSalesBlocked';

vi.mock('server-only', () => ({}));

const item = (id: string, no: string, salesBlocked: boolean, connection = 'conn-1') => ({
  id,
  organization_id: 'org-1',
  bc_connection_id: connection,
  bc_item_number: no,
  sales_blocked: salesBlocked,
});

function transportWith(flags: Record<string, boolean>) {
  const list = vi.fn(async () =>
    Object.entries(flags).map(([No, Sales_Blocked]) => ({ key: { values: { No } }, etag: 'x', fields: { No, Sales_Blocked } })),
  );
  return { list, transport: { list } as unknown as ReferenceTransport };
}

describe('refreshItemSalesBlocked', () => {
  it("copies BC's Sales Blocked flag onto the connection's items and only writes changed rows", async () => {
    const db = fakeSupabase({
      business_central_items: [
        item('i1', 'ING-1001', false), // newly blocked in BC
        item('i2', 'P-1001', true), // unblocked in BC
        item('i3', 'P-1002', false), // unchanged
        item('i4', 'ING-1001', false, 'conn-2'), // other connection: untouched
      ],
    });
    const { list, transport } = transportWith({ 'ING-1001': true, 'P-1001': false, 'P-1002': false });

    const changed = await refreshItemSalesBlocked({ supabase: db.client, transport, orgId: 'org-1', connectionId: 'conn-1' });

    expect(changed).toBe(2);
    expect(list).toHaveBeenCalledWith(ITEM_CARD_SOURCE, { select: ['No', 'Sales_Blocked'] });
    const byId = Object.fromEntries(db.tables.business_central_items.map((r) => [r.id, r.sales_blocked]));
    expect(byId).toEqual({ i1: true, i2: false, i3: false, i4: false });
    expect(db.writes.filter(([, op]) => op === 'update')).toHaveLength(2);
  });

  it('an item missing from the Item Card list counts as not sales blocked', async () => {
    const db = fakeSupabase({ business_central_items: [item('i1', 'GONE', true)] });
    const { transport } = transportWith({});
    await refreshItemSalesBlocked({ supabase: db.client, transport, orgId: 'org-1', connectionId: 'conn-1' });
    expect(db.tables.business_central_items[0].sales_blocked).toBe(false);
  });
});
