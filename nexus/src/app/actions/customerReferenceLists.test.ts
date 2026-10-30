import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireScope: vi.fn(),
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
  createBcClientForOrg: vi.fn(),
  createTransport: vi.fn(),
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
  createReferenceTransportForOrg: mocks.createTransport,
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

const scope = (isAdmin: boolean) => ({ orgId: 'org-1', bcConnectionId: 'conn-1', access: { isAdmin } });

function fakeClient(rows: Record<string, unknown>[]) {
  const calls = { table: '', eq: [] as [string, unknown][], order: [] as string[], select: '' };
  const q: any = {
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
  mocks.createBcClientForOrg.mockResolvedValue({ bc: true });
  mocks.createTransport.mockResolvedValue({ transport: true });
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

  it('edit on taxJurisdictions does not sync', async () => {
    mocks.requireScope.mockResolvedValue(scope(true));
    mocks.saveEntry.mockResolvedValue({ id: 'e' });
    await saveReferenceEntry('taxJurisdictions', { id: 'e', original: { code: 'J1' }, edited: { code: 'J1' } });
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
    expect(calls.eq).toEqual([['organization_id', 'org-1'], ['bc_connection_id', 'conn-1']]);
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
    expect(opts).toEqual([{ code: 'J1', label: 'J1' }]);
  });
});
