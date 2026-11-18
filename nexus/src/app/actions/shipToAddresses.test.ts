import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireScope: vi.fn(),
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
  createBcClientForOrg: vi.fn(),
  createTransport: vi.fn(),
  getCompany: vi.fn(),
  saveShipTo: vi.fn(),
  deleteShipTo: vi.fn(),
  setDefaultShipTo: vi.fn(),
  pullShipTos: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/businessCentral/environmentScope', () => ({ requireActiveBusinessCentralScope: mocks.requireScope }));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient, createServiceClient: mocks.createServiceClient }));
vi.mock('@/lib/businessCentral/client', () => ({ createBcClientForOrg: mocks.createBcClientForOrg }));
vi.mock('@/lib/businessCentral/customerReferences/transport', () => ({ createReferenceTransport: mocks.createTransport }));
vi.mock('@/lib/businessCentral/shipTo/shipToService', () => ({
  saveShipTo: mocks.saveShipTo,
  deleteShipTo: mocks.deleteShipTo,
  setDefaultShipTo: mocks.setDefaultShipTo,
  pullShipTos: mocks.pullShipTos,
}));

import {
  deleteShipToAction,
  listShipTos,
  refreshShipTos,
  saveShipToAction,
  setDefaultShipToAction,
} from './shipToAddresses';

const NO_PERMISSION = "You don't have permission to change customers";
const scope = (canEditCustomers: boolean, canViewCustomers = true) => ({
  orgId: 'org-1',
  bcConnectionId: 'conn-1',
  access: { canEditCustomers, canViewCustomers },
});
const values = { code: '', name: 'N', address: 'A' } as never;
const bc = { config: { companyId: 'c1' }, getCompany: mocks.getCompany };

function listClient(rows: unknown[]) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) q[m] = () => q;
  q.order = () => Promise.resolve({ data: rows, error: null });
  return { from: () => q };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createServiceClient.mockReturnValue({ svc: true });
  mocks.getCompany.mockResolvedValue({ name: 'CRONUS' });
  mocks.createBcClientForOrg.mockResolvedValue(bc);
  mocks.createTransport.mockReturnValue({ transport: true });
});

describe('permission', () => {
  it('refuses the write actions without canEditCustomers', async () => {
    mocks.requireScope.mockResolvedValue(scope(false));
    expect(await saveShipToAction({ customerNumber: 'C1', values })).toEqual({ ok: false, error: NO_PERMISSION });
    expect(await deleteShipToAction('x')).toEqual({ ok: false, error: NO_PERMISSION });
    expect(await setDefaultShipToAction('C1', 'A')).toEqual({ ok: false, error: NO_PERMISSION });
    expect(mocks.createBcClientForOrg).not.toHaveBeenCalled();
  });

  it('listShipTos returns nothing without canViewCustomers', async () => {
    mocks.requireScope.mockResolvedValue(scope(false, false));
    expect(await listShipTos('C1')).toEqual([]);
  });
});

describe('writes', () => {
  beforeEach(() => mocks.requireScope.mockResolvedValue(scope(true)));

  it('saves with built deps and revalidates', async () => {
    mocks.saveShipTo.mockResolvedValue({ id: 's1' });
    expect(await saveShipToAction({ customerNumber: 'C1', values })).toEqual({ ok: true, row: { id: 's1' } });
    expect(mocks.saveShipTo.mock.calls[0][0]).toMatchObject({ orgId: 'org-1', connectionId: 'conn-1', transport: { transport: true } });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/customers', 'layout');
  });

  it('turns a service error into { ok: false }', async () => {
    mocks.deleteShipTo.mockRejectedValue(new Error('boom'));
    expect(await deleteShipToAction('s1')).toEqual({ ok: false, error: 'boom' });
  });

  it('sets the default', async () => {
    expect(await setDefaultShipToAction('C1', 'A')).toEqual({ ok: true });
    expect(mocks.setDefaultShipTo.mock.calls[0].slice(1)).toEqual(['C1', 'A']);
  });
});

describe('refreshShipTos', () => {
  beforeEach(() => mocks.requireScope.mockResolvedValue(scope(false)));

  it('pulls for the customer then returns local rows', async () => {
    mocks.pullShipTos.mockResolvedValue({ upserted: 1, deleted: 0 });
    mocks.createClient.mockResolvedValue(listClient([{ id: 'r1' }]));
    expect(await refreshShipTos('C1')).toEqual([{ id: 'r1' }]);
    expect(mocks.pullShipTos.mock.calls[0][1]).toBe('C1');
  });

  it('on pull failure logs and still returns local rows', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.pullShipTos.mockRejectedValue(new Error('down'));
    mocks.createClient.mockResolvedValue(listClient([{ id: 'r1' }]));
    expect(await refreshShipTos('C1')).toEqual([{ id: 'r1' }]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
