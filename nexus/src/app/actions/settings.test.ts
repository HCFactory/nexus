import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, type FakeSupabase } from '@/test/fakeSupabase';

const mocks = vi.hoisted(() => ({
  isAdmin: true,
  db: null as unknown as FakeSupabase,
}));

vi.mock('@/lib/auth/currentUserAccess', () => ({
  requireOrganizationContext: async () => ({ orgId: 'org-1', user: { id: 'u1' }, access: { isAdmin: mocks.isAdmin } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => mocks.db.client }));

import { getOrgOrderSettings, upsertOrgOrderSettings } from './settings';

beforeEach(() => {
  mocks.isAdmin = true;
  mocks.db = fakeSupabase({ org_order_settings: [] });
});

describe('Order Number Format is admin-only', () => {
  it('admins get the defaults when nothing is saved', async () => {
    expect(await getOrgOrderSettings()).toEqual({ order_prefix: 'PO', order_padding: 5 });
  });

  it('admins get the saved format', async () => {
    mocks.db.tables.org_order_settings.push({ organization_id: 'org-1', order_prefix: 'SO', order_padding: 6 });
    expect(await getOrgOrderSettings()).toMatchObject({ order_prefix: 'SO', order_padding: 6 });
  });

  it('non-admins get null (the card is hidden)', async () => {
    mocks.isAdmin = false;
    mocks.db.tables.org_order_settings.push({ organization_id: 'org-1', order_prefix: 'SO', order_padding: 6 });
    expect(await getOrgOrderSettings()).toBeNull();
  });

  it('admins can save', async () => {
    await upsertOrgOrderSettings({ order_prefix: ' so ', order_padding: 6 });
    expect(mocks.db.tables.org_order_settings[0]).toMatchObject({ organization_id: 'org-1', order_prefix: 'SO', order_padding: 6 });
  });

  it('non-admins cannot save', async () => {
    mocks.isAdmin = false;
    await expect(upsertOrgOrderSettings({ order_prefix: 'XX', order_padding: 3 })).rejects.toThrow(
      'Only admins can change the order number format.',
    );
    expect(mocks.db.tables.org_order_settings).toEqual([]);
  });
});
