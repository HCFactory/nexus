import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — businessCentralConnections.ts is a 'use server' module that reaches
// out to auth, the service-role Supabase client and Next.js cache helpers.
// vi.hoisted lets the mock factories share these spies.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireOrganizationContext: vi.fn(),
  requirePermission: vi.fn(),
  createServiceClient: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/auth/currentUserAccess', () => ({
  requireOrganizationContext: mocks.requireOrganizationContext,
  requirePermission: mocks.requirePermission,
}));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: mocks.createServiceClient,
}));

import {
  createBcConnection,
  deleteBcConnection,
  updateBcConnection,
  upsertBcCredentials,
} from './businessCentralConnections';

const ORG_ID = 'org-1';

// ---------------------------------------------------------------------------
// Minimal chainable Supabase mock
// ---------------------------------------------------------------------------
type QueryResult = { data?: unknown; error: unknown; count?: number };

interface QueryChain {
  select: () => QueryChain;
  insert: () => QueryChain;
  upsert: () => QueryChain;
  update: (payload?: unknown) => QueryChain;
  delete: () => QueryChain;
  eq: () => QueryChain;
  order: () => QueryChain;
  single: () => Promise<QueryResult>;
  maybeSingle: () => Promise<QueryResult>;
  then: (
    onFulfilled: (value: QueryResult) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise<unknown>;
}

interface SupabaseMock {
  client: { from: ReturnType<typeof vi.fn>; rpc: ReturnType<typeof vi.fn> };
  /** `${table}:${op}` recorded each time a query is actually awaited. */
  ops: string[];
  /** Payloads passed to update(), in order. */
  updates: unknown[];
  rpc: ReturnType<typeof vi.fn>;
}

function createSupabaseMock(
  resolve: (table: string, op: string) => QueryResult,
): SupabaseMock {
  const ops: string[] = [];
  const updates: unknown[] = [];
  const rpc = vi.fn();

  function makeChain(table: string): QueryChain {
    let op = 'select';
    const settle = (): QueryResult => {
      ops.push(`${table}:${op}`);
      return resolve(table, op);
    };
    const chain = {} as QueryChain;
    chain.select = () => ((op = 'select'), chain);
    chain.insert = () => ((op = 'insert'), chain);
    chain.upsert = () => ((op = 'upsert'), chain);
    chain.update = (payload?: unknown) => ((op = 'update'), updates.push(payload), chain);
    chain.delete = () => ((op = 'delete'), chain);
    chain.eq = () => chain;
    chain.order = () => chain;
    chain.single = () => Promise.resolve(settle());
    chain.maybeSingle = () => Promise.resolve(settle());
    chain.then = (onFulfilled, onRejected) =>
      Promise.resolve(settle()).then(onFulfilled, onRejected);
    return chain;
  }

  const from = vi.fn((table: string) => makeChain(table));
  return { client: { from, rpc }, ops, updates, rpc };
}

beforeEach(() => {
  vi.clearAllMocks();
  const context = { orgId: ORG_ID, user: { id: 'user-1' }, access: {} };
  mocks.requireOrganizationContext.mockResolvedValue(context);
  mocks.requirePermission.mockResolvedValue(context);
});

// ---------------------------------------------------------------------------
// upsertBcCredentials — the secret must never be rotated when the input is blank
// ---------------------------------------------------------------------------
describe('upsertBcCredentials', () => {
  function setup() {
    const supa = createSupabaseMock((table, op) => {
      if (table === 'business_central_credentials' && op === 'upsert') {
        return { error: null };
      }
      return { data: null, error: null };
    });
    mocks.createServiceClient.mockReturnValue(supa.client);
    return supa;
  }

  it('keeps the existing Vault secret when the input secret is an empty string', async () => {
    const supa = setup();

    await upsertBcCredentials({
      tenantId: 'tenant',
      clientId: 'client',
      companyId: 'company',
      clientSecret: '',
    });

    // The credentials row is still written...
    expect(supa.ops).toContain('business_central_credentials:upsert');
    // ...but set_bc_client_secret is NEVER called for a blank secret.
    expect(supa.rpc).not.toHaveBeenCalled();
  });

  it('keeps the existing secret when the secret is omitted (null/undefined)', async () => {
    const supa = setup();

    await upsertBcCredentials({ tenantId: 'tenant', clientId: 'client', companyId: 'company' });
    await upsertBcCredentials({
      tenantId: 'tenant',
      clientId: 'client',
      companyId: 'company',
      clientSecret: null,
    });

    expect(supa.rpc).not.toHaveBeenCalled();
  });

  it('keeps the existing secret when the secret is whitespace only', async () => {
    const supa = setup();

    await upsertBcCredentials({
      tenantId: 'tenant',
      clientId: 'client',
      companyId: 'company',
      clientSecret: '   ',
    });

    expect(supa.rpc).not.toHaveBeenCalled();
  });

  it('rotates the secret via set_bc_client_secret when a non-blank secret is supplied', async () => {
    const supa = setup();
    supa.rpc.mockResolvedValue({ data: 'secret-id', error: null });

    await upsertBcCredentials({
      tenantId: 'tenant',
      clientId: 'client',
      companyId: 'company',
      clientSecret: 'real-secret',
    });

    expect(supa.rpc).toHaveBeenCalledWith('set_bc_client_secret', {
      p_org_id: ORG_ID,
      p_secret: 'real-secret',
    });
  });

  it('requires a non-empty company ID', async () => {
    setup();

    await expect(
      upsertBcCredentials({ tenantId: 'tenant', clientId: 'client', companyId: '   ' }),
    ).rejects.toThrow(/Company ID is required/);
  });

  it('mirrors the shared company ID onto the org connections', async () => {
    const supa = setup();

    await upsertBcCredentials({ tenantId: 'tenant', clientId: 'client', companyId: 'company' });

    // The credentials row is the source of truth; the connections carry a mirror.
    expect(supa.ops).toContain('business_central_credentials:upsert');
    expect(supa.ops).toContain('business_central_connections:update');
  });
});

// ---------------------------------------------------------------------------
// createBcConnection — the shared company is sourced from the credentials row
// ---------------------------------------------------------------------------
describe('createBcConnection', () => {
  it('refuses to create an environment when no credentials company ID exists', async () => {
    const supa = createSupabaseMock((table) => {
      if (table === 'business_central_credentials') {
        return { data: { company_id: null }, error: null };
      }
      return { data: null, error: null };
    });
    mocks.createServiceClient.mockReturnValue(supa.client);

    await expect(
      createBcConnection({ displayName: 'Test', environment: 'SANDBOX' }),
    ).rejects.toThrow(/Configure Business Central credentials/);
    // It bails before touching business_central_connections at all.
    expect(supa.ops.some((op) => op.startsWith('business_central_connections:'))).toBe(false);
  });

  it('inserts a connection using the org credentials company ID', async () => {
    const supa = createSupabaseMock((table) => {
      if (table === 'business_central_credentials') {
        return { data: { company_id: 'shared-company' }, error: null };
      }
      // The connections chain serves both the head-count query (reads `count`)
      // and the insert→select→single query (reads `data`); the mock keys only
      // by table, so satisfy both shapes from one result.
      if (table === 'business_central_connections') {
        return { data: { id: 'c1' }, error: null, count: 0 };
      }
      return { data: null, error: null };
    });
    mocks.createServiceClient.mockReturnValue(supa.client);

    await expect(
      createBcConnection({ displayName: 'Test', environment: 'SANDBOX' }),
    ).resolves.toEqual({ id: 'c1' });
    // The credentials row was consulted for the shared company id.
    expect(supa.ops).toContain('business_central_credentials:select');
  });
});

// ---------------------------------------------------------------------------
// deleteBcConnection — deleting the org's only environment is blocked
// ---------------------------------------------------------------------------
describe('updateBcConnection: Sync automatically', () => {
  it('saves auto_sync when given and leaves it alone when not', async () => {
    const supa = createSupabaseMock(() => ({ data: { id: 'c1' }, error: null }));
    mocks.createServiceClient.mockReturnValue(supa.client);
    await updateBcConnection('c1', { autoSync: true });
    await updateBcConnection('c1', { displayName: 'Production' });
    expect(supa.updates[0]).toMatchObject({ auto_sync: true });
    expect(supa.updates[1]).not.toHaveProperty('auto_sync');
  });
});

describe('updateBcConnection: Bill.com via its BC connector', () => {
  it('saves the switch when given and leaves it alone when not', async () => {
    const supa = createSupabaseMock(() => ({ data: { id: 'c1' }, error: null }));
    mocks.createServiceClient.mockReturnValue(supa.client);
    await updateBcConnection('c1', { billcomViaConnector: true });
    await updateBcConnection('c1', { displayName: 'Production' });
    expect(supa.updates[0]).toMatchObject({ billcom_via_connector: true });
    expect(supa.updates[1]).not.toHaveProperty('billcom_via_connector');
  });
});

describe('updateBcConnection: Bill.com and Stripe connections per environment', () => {
  it('saves the picked connections after checking they belong to the org; null clears a pick', async () => {
    const supa = createSupabaseMock((table) =>
      table === 'billcom_connections' ? { data: { id: 'bill-1' }, error: null }
        : table === 'stripe_connections' ? { data: { id: 'str-1' }, error: null }
        : { data: { id: 'c1' }, error: null });
    mocks.createServiceClient.mockReturnValue(supa.client);
    await updateBcConnection('c1', { billcomConnectionId: 'bill-1', stripeConnectionId: 'str-1' });
    await updateBcConnection('c1', { billcomConnectionId: null, stripeConnectionId: null });
    await updateBcConnection('c1', { displayName: 'TEST' });
    expect(supa.updates[0]).toMatchObject({ billcom_connection_id: 'bill-1', stripe_connection_id: 'str-1' });
    expect(supa.updates[1]).toMatchObject({ billcom_connection_id: null, stripe_connection_id: null });
    expect(supa.updates[2]).not.toHaveProperty('billcom_connection_id');
    expect(supa.updates[2]).not.toHaveProperty('stripe_connection_id');
    expect(supa.ops).toContain('billcom_connections:select');
    expect(supa.ops).toContain('stripe_connections:select');
  });

  it("refuses a connection that isn't in this organisation, without saving", async () => {
    const supa = createSupabaseMock((table) =>
      table === 'billcom_connections' || table === 'stripe_connections' ? { data: null, error: null } : { data: { id: 'c1' }, error: null });
    mocks.createServiceClient.mockReturnValue(supa.client);
    await expect(updateBcConnection('c1', { billcomConnectionId: 'foreign' })).rejects.toThrow('Bill.com connection not found');
    await expect(updateBcConnection('c1', { stripeConnectionId: 'foreign' })).rejects.toThrow('Stripe connection not found');
    expect(supa.updates).toEqual([]);
  });
});

describe('deleteBcConnection', () => {
  it('refuses to delete the only environment and never issues a delete', async () => {
    const supa = createSupabaseMock((_table, op) => {
      if (op === 'select') {
        return { data: [{ id: 'c1', is_default: true }], error: null };
      }
      return { error: null };
    });
    mocks.createServiceClient.mockReturnValue(supa.client);

    await expect(deleteBcConnection('c1')).rejects.toThrow(
      /Cannot delete the only Business Central environment/,
    );
    expect(supa.ops).not.toContain('business_central_connections:delete');
  });

  it('deletes a connection when more than one environment exists', async () => {
    const supa = createSupabaseMock((_table, op) => {
      if (op === 'select') {
        return {
          data: [
            { id: 'c1', is_default: true },
            { id: 'c2', is_default: false },
          ],
          error: null,
        };
      }
      return { error: null };
    });
    mocks.createServiceClient.mockReturnValue(supa.client);

    await expect(deleteBcConnection('c1')).resolves.toBeUndefined();
    expect(supa.ops).toContain('business_central_connections:delete');
    // c1 was the default → another connection is promoted.
    expect(supa.ops).toContain('business_central_connections:update');
  });
});
