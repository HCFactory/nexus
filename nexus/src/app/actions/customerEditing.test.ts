import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireScope: vi.fn(),
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
  createBcClientForOrg: vi.fn(),
  createTransport: vi.fn(),
  createNoSeriesClient: vi.fn(),
  createAssigner: vi.fn(),
  getCompany: vi.fn(),
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  deleteCustomer: vi.fn(),
  getSelectOptions: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/businessCentral/environmentScope', () => ({ requireActiveBusinessCentralScope: mocks.requireScope }));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient, createServiceClient: mocks.createServiceClient }));
vi.mock('@/lib/businessCentral/client', () => ({ createBcClientForOrg: mocks.createBcClientForOrg }));
vi.mock('@/lib/businessCentral/customerReferences/transport', () => ({ createReferenceTransport: mocks.createTransport }));
vi.mock('@/lib/businessCentral/noSeriesClient', () => ({ createNoSeriesClient: mocks.createNoSeriesClient }));
vi.mock('@/lib/businessCentral/numberAssigner', () => ({ createBcNoSeriesAssigner: mocks.createAssigner }));
vi.mock('@/lib/businessCentral/customers/customerService', () => ({
  createCustomer: mocks.createCustomer,
  updateCustomer: mocks.updateCustomer,
  deleteCustomer: mocks.deleteCustomer,
}));
vi.mock('./customerReferenceLists', () => ({ getSelectOptions: mocks.getSelectOptions }));

import { createCustomerAction, deleteCustomerAction, getCustomerEditContext, updateCustomerAction } from './customerEditing';

const NO_PERMISSION = "You don't have permission to change customers";
const scope = (canEditCustomers: boolean) => ({
  orgId: 'org-1',
  bcConnectionId: 'conn-1',
  connection: { id: 'conn-1', time_zone: null },
  access: { canEditCustomers, canViewCustomers: true },
});

const bc = { config: { companyId: 'c1', environment: 'TEST' }, getCompany: mocks.getCompany, listResourcePage: vi.fn() };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createServiceClient.mockReturnValue({ svc: true });
  mocks.getCompany.mockResolvedValue({ name: 'CRONUS' });
  mocks.createBcClientForOrg.mockResolvedValue(bc);
  mocks.createTransport.mockReturnValue({ transport: true });
  mocks.createNoSeriesClient.mockReturnValue({ noSeries: true });
  mocks.createAssigner.mockReturnValue({ assigner: true });
});

describe('permission', () => {
  it('refuses create, update and delete without canEditCustomers', async () => {
    mocks.requireScope.mockResolvedValue(scope(false));
    expect(await createCustomerAction({ templateCode: 'T', values: {} })).toEqual({ ok: false, error: NO_PERMISSION });
    expect(await updateCustomerAction({ id: 'x', original: {}, edited: {} })).toEqual({ ok: false, error: NO_PERMISSION });
    expect(await deleteCustomerAction('x')).toEqual({ ok: false, error: NO_PERMISSION });
    expect(mocks.createBcClientForOrg).not.toHaveBeenCalled();
    expect(mocks.createCustomer).not.toHaveBeenCalled();
    expect(mocks.updateCustomer).not.toHaveBeenCalled();
    expect(mocks.deleteCustomer).not.toHaveBeenCalled();
  });
});

describe('with permission', () => {
  beforeEach(() => mocks.requireScope.mockResolvedValue(scope(true)));

  it('creates through the service with scoped deps and revalidates /customers', async () => {
    mocks.createCustomer.mockResolvedValue({ id: 'new-1', number: 'C100', warning: 'heads up' });
    const res = await createCustomerAction({ templateCode: 'T1', values: { display_name: 'ZZNEXUS A' } });
    expect(res).toEqual({ ok: true, id: 'new-1', number: 'C100', warning: 'heads up' });
    const [deps, input] = mocks.createCustomer.mock.calls[0];
    expect(deps).toMatchObject({
      supabase: { svc: true },
      transport: { transport: true },
      assigner: { assigner: true },
      bc,
      orgId: 'org-1',
      connectionId: 'conn-1',
      environment: 'TEST',
      companyId: 'c1',
    });
    expect(mocks.createBcClientForOrg).toHaveBeenCalledWith('org-1', 'conn-1');
    expect(mocks.createTransport).toHaveBeenCalledWith(bc, 'CRONUS');
    expect(mocks.createNoSeriesClient).toHaveBeenCalledWith(bc, 'CRONUS');
    expect(input).toEqual({ templateCode: 'T1', values: { display_name: 'ZZNEXUS A' } });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/customers', 'layout');
  });

  it('updates and deletes through the service and revalidates', async () => {
    expect(await updateCustomerAction({ id: 'c1', original: { city: 'A' }, edited: { city: 'B' } })).toEqual({ ok: true });
    expect(mocks.updateCustomer.mock.calls[0][1]).toEqual({ id: 'c1', original: { city: 'A' }, edited: { city: 'B' } });
    expect(await deleteCustomerAction('c1')).toEqual({ ok: true });
    expect(mocks.deleteCustomer.mock.calls[0][1]).toBe('c1');
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(2);
  });

  it('returns the service error text verbatim', async () => {
    mocks.deleteCustomer.mockRejectedValue(new Error('Has entries. You can set Blocked to All instead.'));
    expect(await deleteCustomerAction('c1')).toEqual({ ok: false, error: 'Has entries. You can set Blocked to All instead.' });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('getCustomerEditContext', () => {
  it('is empty without permission', async () => {
    mocks.requireScope.mockResolvedValue(scope(false));
    expect(await getCustomerEditContext()).toEqual({ canEdit: false, templates: [], selectOptions: {} });
  });

  it('loads scoped templates and dropdown options', async () => {
    mocks.requireScope.mockResolvedValue(scope(true));
    const eqs: [string, unknown][] = [];
    const rows = [{ code: 'RETAIL', display_name: 'Retail', payment_terms_code: 'N30', tax_area_code: 'CA' }];
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => { eqs.push([c, v]); return q; },
      order: () => Promise.resolve({ data: rows, error: null }),
    };
    mocks.createClient.mockResolvedValue({ from: (t: string) => { expect(t).toBe('business_central_customer_templates'); return q; } });
    mocks.getSelectOptions.mockImplementation(async (s: string) => [{ code: `${s}-1`, label: `${s}-1` }]);
    const ctx = await getCustomerEditContext();
    expect(eqs).toEqual([['organization_id', 'org-1'], ['bc_connection_id', 'conn-1']]);
    expect(ctx.canEdit).toBe(true);
    expect(ctx.templates).toEqual([{ code: 'RETAIL', label: 'RETAIL — Retail', values: { payment_terms_code: 'N30', tax_area_code: 'CA' } }]);
    expect(ctx.selectOptions.paymentTerms).toEqual([{ code: 'paymentTerms-1', label: 'paymentTerms-1' }]);
    expect(Object.keys(ctx.selectOptions).sort()).toEqual(
      ['customerPostingGroups', 'customerPriceGroups', 'generalBusinessPostingGroups', 'locations', 'paymentTerms', 'taxAreas'],
    );
  });
});
