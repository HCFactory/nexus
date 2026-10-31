import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireScope: vi.fn(),
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
  createBcClientForOrg: vi.fn(),
  createTransport: vi.fn(),
  getCompany: vi.fn(),
  createUsageCounter: vi.fn(),
  saveEntry: vi.fn(),
  deleteEntry: vi.fn(),
  syncList: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/businessCentral/environmentScope', () => ({ requireActiveBusinessCentralScope: mocks.requireScope }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: mocks.createClient,
  createServiceClient: mocks.createServiceClient,
}));
vi.mock('@/lib/businessCentral/client', () => ({ createBcClientForOrg: mocks.createBcClientForOrg }));
vi.mock('@/lib/businessCentral/customerReferences/transport', () => ({
  createReferenceTransport: mocks.createTransport,
}));
vi.mock('@/lib/businessCentral/customerReferences/usage', () => ({ createUsageCounter: mocks.createUsageCounter }));
vi.mock('@/lib/businessCentral/customerReferences/service', () => ({
  saveEntry: mocks.saveEntry,
  deleteEntry: mocks.deleteEntry,
  syncList: mocks.syncList,
}));

import {
  deleteReferenceEntry,
  getReferenceListPage,
  getSelectOptions,
  saveReferenceEntry,
  syncReferenceList,
} from './customerReferenceLists';
import type { ListKey } from '@/types/customerReferences';

const scope = (isAdmin: boolean) => ({ orgId: 'org-1', bcConnectionId: 'conn-1', access: { isAdmin } });

function fakeClient(rows: Record<string, unknown>[]) {
  const calls = { table: '', eq: [] as [string, unknown][], order: [] as string[], select: '' };
  interface Query {
    select(s: string): Query;
    eq(c: string, v: unknown): Query;
    order(c: string): Query;
    then(res: (v: unknown) => unknown): unknown;
  }
  const q: Query = {
    select: (s: string) => { calls.select = s; return q; },
    eq: (c: string, v: unknown) => { calls.eq.push([c, v]); return q; },
    order: (c: string) => { calls.order.push(c); return q; },
    then: (res: (v: unknown) => unknown) => res({ data: rows, error: null }),
  };
  return { client: { from: (t: string) => { calls.table = t; return q; } }, calls };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createServiceClient.mockReturnValue({ svc: true });
  mocks.getCompany.mockResolvedValue({ name: 'CRONUS' });
  mocks.createBcClientForOrg.mockResolvedValue({ config: { companyId: 'c1' }, getCompany: mocks.getCompany });
  mocks.createTransport.mockReturnValue({ transport: true });
  mocks.createUsageCounter.mockReturnValue(() => null);
  mocks.syncList.mockResolvedValue({ inserted: 1, updated: 2, deleted: 3 });
});

describe('saveReferenceEntry', () => {
  it('rejects non-admins without calling BC', async () => {
    mocks.requireScope.mockResolvedValue(scope(false));
    const res = await saveReferenceEntry('paymentTerms', { id: null, original: null, edited: { code: 'N30' } });
    expect(res).toEqual({ ok: false, error: 'Only admins can change customer reference lists' });
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.saveEntry).not.toHaveBeenCalled();
  });

  it('rejects read-only lists', async () => {
    mocks.requireScope.mockResolvedValue(scope(true));
    const res = await saveReferenceEntry('locations', { id: null, original: null, edited: {} });
    expect(res).toEqual({ ok: false, error: 'This list is managed in Business Central' });
    expect(mocks.saveEntry).not.toHaveBeenCalled();
  });

  it('returns the BC error message verbatim', async () => {
    mocks.requireScope.mockResolvedValue(scope(true));
    mocks.saveEntry.mockRejectedValue(new Error('The Code already exists.'));
    const res = await saveReferenceEntry('paymentTerms', { id: null, original: null, edited: { code: 'N30' } });
    expect(res).toEqual({ ok: false, error: 'The Code already exists.' });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('strips non-editable fields before saving and revalidates', async () => {
    mocks.requireScope.mockResolvedValue(scope(true));
    const entry = { id: 'e1', values: {}, bcLastModifiedAt: null, lastSyncedAt: null };
    mocks.saveEntry.mockResolvedValue(entry);
    const res = await saveReferenceEntry('taxAreas', {
      id: 'e1',
      original: { code: 'A', display_name: 'x', tax_type: 'Sales' },
      edited: { code: 'A', display_name: 'y', tax_type: 'VAT', bogus: 1 },
    });
    expect(res).toEqual({ ok: true, entry });
    const input = mocks.saveEntry.mock.calls[0][2];
    expect(input.edited).toEqual({ code: 'A', display_name: 'y' });
    expect(input.original).toEqual({ code: 'A', display_name: 'x' });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/customer-lists', 'layout');
  });

  it('keeps tax_area_code on a taxAreaLines create', async () => {
    mocks.requireScope.mockResolvedValue(scope(true));
    mocks.saveEntry.mockResolvedValue({ id: 'e' });
    await saveReferenceEntry('taxAreaLines', {
      id: null,
      original: null,
      edited: { tax_area_code: 'TA', tax_jurisdiction_code: 'J1' },
    });
    expect(mocks.saveEntry.mock.calls[0][2].edited).toEqual({ tax_area_code: 'TA', tax_jurisdiction_code: 'J1' });
  });

  it('create on taxJurisdictions triggers a taxDetails sync', async () => {
    mocks.requireScope.mockResolvedValue(scope(true));
    mocks.saveEntry.mockResolvedValue({ id: 'e' });
    await saveReferenceEntry('taxJurisdictions', { id: null, original: null, edited: { code: 'J1' } });
    expect(mocks.syncList).toHaveBeenCalledTimes(1);
    expect(mocks.syncList.mock.calls[0][1].key).toBe('taxDetails');
  });

  it('passes the BC client and the reference transport to the usage counter', async () => {
    mocks.requireScope.mockResolvedValue(scope(true));
    mocks.deleteEntry.mockResolvedValue(undefined);
    await deleteReferenceEntry('taxJurisdictions', 'x');
    const bc = await mocks.createBcClientForOrg.mock.results[0].value;
    expect(mocks.createUsageCounter).toHaveBeenCalledWith(bc, { transport: true });
  });

  it('create succeeds with a warning when the follow-up taxDetails sync throws', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.requireScope.mockResolvedValue(scope(true));
    const entry = { id: 'e' };
    mocks.saveEntry.mockResolvedValue(entry);
    mocks.syncList.mockRejectedValue(new Error('BC down'));
    const res = await saveReferenceEntry('taxJurisdictions', { id: null, original: null, edited: { code: 'J1' } });
    expect(res).toEqual({
      ok: true,
      entry,
      warning: 'Saved, but refreshing tax details from Business Central failed. Press Sync on Tax details.',
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/customer-lists', 'layout');
    expect(logged).toHaveBeenCalled();
    expect(String(logged.mock.calls[0]?.join(' '))).toContain('BC down');
    logged.mockRestore();
  });

  it('edit on taxJurisdictions does not sync', async () => {
    mocks.requireScope.mockResolvedValue(scope(true));
    mocks.saveEntry.mockResolvedValue({ id: 'e' });
    await saveReferenceEntry('taxJurisdictions', { id: 'e', original: { code: 'J1' }, edited: { code: 'J1' } });
    expect(mocks.syncList).not.toHaveBeenCalled();
  });

  it('renaming a jurisdiction re-pulls tax area lines and tax details', async () => {
    mocks.requireScope.mockResolvedValue(scope(true));
    mocks.saveEntry.mockResolvedValue({ id: 'e' });
    await saveReferenceEntry('taxJurisdictions', { id: 'e', original: { code: 'J1' }, edited: { code: 'J2' } });
    expect(mocks.syncList.mock.calls.map((c) => c[1].key)).toEqual(['taxAreaLines', 'taxDetails']);
  });

  it('renaming a tax area re-pulls its lines', async () => {
    mocks.requireScope.mockResolvedValue(scope(true));
    mocks.saveEntry.mockResolvedValue({ id: 'e' });
    await saveReferenceEntry('taxAreas', { id: 'e', original: { code: 'A1' }, edited: { code: 'A2' } });
    expect(mocks.syncList.mock.calls.map((c) => c[1].key)).toEqual(['taxAreaLines', 'customerTemplates']);
  });

  it.each(['paymentTerms', 'customerPriceGroups'] as const)(
    'renaming %s re-pulls customer templates only',
    async (key) => {
      mocks.requireScope.mockResolvedValue(scope(true));
      mocks.saveEntry.mockResolvedValue({ id: 'e' });
      await saveReferenceEntry(key, { id: 'e', original: { code: 'N30' }, edited: { code: 'N31' } });
      expect(mocks.syncList.mock.calls.map((c) => c[1].key)).toEqual(['customerTemplates']);
    },
  );

  it('rename follow-up failure on customerTemplates is a warning', async () => {
    mocks.requireScope.mockResolvedValue(scope(true));
    mocks.saveEntry.mockResolvedValue({ id: 'e' });
    mocks.syncList.mockRejectedValue(new Error('BC down'));
    const res = await saveReferenceEntry('paymentTerms', { id: 'e', original: { code: 'N30' }, edited: { code: 'N31' } });
    expect(res).toMatchObject({ ok: true, warning: expect.stringContaining('Customer templates') });
  });

  it('names every failed follow-up in one warning', async () => {
    mocks.requireScope.mockResolvedValue(scope(true));
    mocks.saveEntry.mockResolvedValue({ id: 'e' });
    mocks.syncList.mockRejectedValue(new Error('BC down'));
    const res = await saveReferenceEntry('taxAreas', { id: 'e', original: { code: 'A1' }, edited: { code: 'A2' } });
    expect(res).toMatchObject({ ok: true, warning: expect.stringContaining('Tax area lines') });
    expect(res).toMatchObject({ warning: expect.stringContaining('Customer templates') });
  });

  it('creating a customer template triggers no follow-up', async () => {
    mocks.requireScope.mockResolvedValue(scope(true));
    mocks.saveEntry.mockResolvedValue({ id: 'e' });
    await saveReferenceEntry('customerTemplates', { id: null, original: null, edited: { code: 'T1' } });
    expect(mocks.syncList).not.toHaveBeenCalled();
  });
});

describe('deleteReferenceEntry', () => {
  it('rejects non-admins', async () => {
    mocks.requireScope.mockResolvedValue(scope(false));
    expect(await deleteReferenceEntry('paymentTerms', 'x')).toEqual({
      ok: false,
      error: 'Only admins can change customer reference lists',
    });
  });

  it('rejects read-only lists', async () => {
    mocks.requireScope.mockResolvedValue(scope(true));
    expect(await deleteReferenceEntry('locations', 'x')).toEqual({
      ok: false,
      error: 'This list is managed in Business Central',
    });
  });

  it('returns deleteDisabledReason without calling BC', async () => {
    mocks.requireScope.mockResolvedValue(scope(true));
    const res = await deleteReferenceEntry('customerPriceGroups', 'x');
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toMatch(/customer sync project 3/);
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.deleteEntry).not.toHaveBeenCalled();
  });

  it('returns in-use message verbatim and succeeds otherwise', async () => {
    mocks.requireScope.mockResolvedValue(scope(true));
    mocks.deleteEntry.mockRejectedValueOnce(new Error('Used by 2 customers'));
    expect(await deleteReferenceEntry('paymentTerms', 'x')).toEqual({ ok: false, error: 'Used by 2 customers' });
    mocks.deleteEntry.mockResolvedValueOnce(undefined);
    expect(await deleteReferenceEntry('paymentTerms', 'x')).toEqual({ ok: true });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/customer-lists', 'layout');
  });
});

describe('syncReferenceList', () => {
  it('rejects non-admins', async () => {
    mocks.requireScope.mockResolvedValue(scope(false));
    expect((await syncReferenceList('locations')).ok).toBe(false);
  });

  it('syncs read-only lists for admins', async () => {
    mocks.requireScope.mockResolvedValue(scope(true));
    expect(await syncReferenceList('locations')).toEqual({ ok: true, inserted: 1, updated: 2, deleted: 3 });
    expect(mocks.syncList).toHaveBeenCalledTimes(1);
  });

  it('syncing tax areas also syncs tax area lines and sums the counts', async () => {
    mocks.requireScope.mockResolvedValue(scope(true));
    mocks.syncList
      .mockResolvedValueOnce({ inserted: 1, updated: 2, deleted: 3 })
      .mockResolvedValueOnce({ inserted: 10, updated: 20, deleted: 30 });
    expect(await syncReferenceList('taxAreas')).toEqual({ ok: true, inserted: 11, updated: 22, deleted: 33 });
    expect(mocks.syncList.mock.calls.map((c) => c[1].key)).toEqual(['taxAreas', 'taxAreaLines']);
  });

  it('syncing customer templates syncs number series first and sums the counts', async () => {
    mocks.requireScope.mockResolvedValue(scope(true));
    mocks.syncList
      .mockResolvedValueOnce({ inserted: 1, updated: 2, deleted: 3 })
      .mockResolvedValueOnce({ inserted: 10, updated: 20, deleted: 30 });
    expect(await syncReferenceList('customerTemplates')).toEqual({ ok: true, inserted: 11, updated: 22, deleted: 33 });
    expect(mocks.syncList.mock.calls.map((c) => c[1].key)).toEqual(['noSeries', 'customerTemplates']);
  });
});

describe('unknown list keys', () => {
  const bogus = 'toString' as unknown as ListKey;

  it('save, delete and sync return Unknown list without touching BC', async () => {
    mocks.requireScope.mockResolvedValue(scope(true));
    expect(await saveReferenceEntry(bogus, { id: null, original: null, edited: {} })).toEqual({ ok: false, error: 'Unknown list' });
    expect(await deleteReferenceEntry(bogus, 'x')).toEqual({ ok: false, error: 'Unknown list' });
    expect(await syncReferenceList(bogus)).toEqual({ ok: false, error: 'Unknown list' });
    expect(mocks.createBcClientForOrg).not.toHaveBeenCalled();
  });

  it('page and select options throw Unknown list', async () => {
    mocks.requireScope.mockResolvedValue(scope(true));
    mocks.createClient.mockResolvedValue(fakeClient([]).client);
    await expect(getReferenceListPage(bogus)).rejects.toThrow('Unknown list');
    await expect(getSelectOptions(bogus)).rejects.toThrow('Unknown list');
  });
});

describe('getReferenceListPage', () => {
  const row = {
    id: 'r1', code: 'N30', display_name: 'Net 30', due_date_calculation: '30D', discount_date_calculation: null,
    discount_percent: 0, calculate_discount_on_credit_memos: false, organization_id: 'org-1',
    bc_last_modified_at: '2026-01-01T00:00:00Z', last_synced_at: '2026-02-01T00:00:00Z',
  };

  it('maps rows, scopes by org + connection, and canManage reflects isAdmin', async () => {
    const { client, calls } = fakeClient([row]);
    mocks.createClient.mockResolvedValue(client);
    mocks.requireScope.mockResolvedValue(scope(true));
    const page = await getReferenceListPage('paymentTerms');
    expect(calls.table).toBe('business_central_payment_terms');
    expect(calls.eq).toEqual([['organization_id', 'org-1'], ['bc_connection_id', 'conn-1']]);
    expect(calls.order).toEqual(['code']);
    expect(page.canManage).toBe(true);
    expect(page.mode).toBe('managed');
    expect(page.deleteDisabledReason).toBeNull();
    expect(page.entries[0]).toMatchObject({
      id: 'r1',
      bcLastModifiedAt: '2026-01-01T00:00:00Z',
      lastSyncedAt: '2026-02-01T00:00:00Z',
    });
    expect(page.entries[0].values).toMatchObject({ code: 'N30', display_name: 'Net 30' });
    expect(page.entries[0].values).not.toHaveProperty('organization_id');

    mocks.requireScope.mockResolvedValue(scope(false));
    expect((await getReferenceListPage('paymentTerms')).canManage).toBe(false);
  });

  it('exposes deleteDisabledReason for price groups', async () => {
    mocks.createClient.mockResolvedValue(fakeClient([]).client);
    mocks.requireScope.mockResolvedValue(scope(true));
    expect((await getReferenceListPage('customerPriceGroups')).deleteDisabledReason).toMatch(/project 3/);
  });

  it('filters taxAreaLines by parentCode', async () => {
    const { client, calls } = fakeClient([]);
    mocks.createClient.mockResolvedValue(client);
    mocks.requireScope.mockResolvedValue(scope(true));
    await getReferenceListPage('taxAreaLines', { parentCode: 'TA1' });
    expect(calls.eq).toContainEqual(['tax_area_code', 'TA1']);
  });

  it('filters taxDetails by jurisdictionCode', async () => {
    const { client, calls } = fakeClient([]);
    mocks.createClient.mockResolvedValue(client);
    mocks.requireScope.mockResolvedValue(scope(true));
    await getReferenceListPage('taxDetails', { jurisdictionCode: 'J1' });
    expect(calls.eq).toContainEqual(['tax_jurisdiction_code', 'J1']);
  });
});

describe('getSelectOptions', () => {
  it('reads tax groups with code — name labels', async () => {
    const { client, calls } = fakeClient([
      { code: 'TAXABLE', display_name: 'Taxable' },
      { code: 'NONTAX', display_name: '' },
    ]);
    mocks.createClient.mockResolvedValue(client);
    mocks.requireScope.mockResolvedValue(scope(false));
    const opts = await getSelectOptions('taxGroups');
    expect(calls.table).toBe('business_central_tax_groups');
    expect(calls.eq).toEqual([['organization_id', 'org-1'], ['bc_connection_id', 'conn-1'], ['is_active', true]]);
    expect(opts).toEqual([
      { code: 'TAXABLE', label: 'TAXABLE — Taxable' },
      { code: 'NONTAX', label: 'NONTAX' },
    ]);
  });

  it('reads a list table for list keys', async () => {
    const { client, calls } = fakeClient([{ code: 'J1' }]);
    mocks.createClient.mockResolvedValue(client);
    mocks.requireScope.mockResolvedValue(scope(false));
    const opts = await getSelectOptions('taxJurisdictions');
    expect(calls.table).toBe('business_central_tax_jurisdictions');
    expect(calls.eq).toEqual([['organization_id', 'org-1'], ['bc_connection_id', 'conn-1']]);
    expect(opts).toEqual([{ code: 'J1', label: 'J1' }]);
  });
});
