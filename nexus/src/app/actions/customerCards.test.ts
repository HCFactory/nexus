import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  updates: [] as Array<{ table: string; values: Row }>,
  access: { canViewCustomers: true, canEditCustomers: true },
  resolveConn: vi.fn(),
  createLink: vi.fn(),
  cancelLinks: vi.fn(),
  sendEmail: vi.fn(),
  detach: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/currentUserAccess', () => ({
  requireOrganizationContext: async () => ({
    orgId: 'org-1',
    user: { id: 'u1' },
    access: mocks.access,
  }),
}));
vi.mock('@/lib/stripe/connection', () => ({
  resolveDefaultStripeConnection: mocks.resolveConn,
  createStripeForConnection: async () => ({ paymentMethods: { detach: mocks.detach } }),
}));
vi.mock('@/lib/stripe/setupLinks', () => ({
  createSetupLink: mocks.createLink,
  cancelSetupLinks: mocks.cancelLinks,
}));
vi.mock('@/lib/email', () => ({ sendCardSetupEmail: mocks.sendEmail }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const nulls: string[] = [];
      const gtFilters: Array<[string, string]> = [];
      let upd: Row | null = null;
      const rows = () =>
        (mocks.tables[table] ?? []).filter(
          (r) =>
            filters.every(([k, v]) => r[k] === v) &&
            nulls.every((k) => r[k] == null) &&
            gtFilters.every(([k, v]) => String(r[k]) > v),
        );
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (k: string, v: unknown) => (filters.push([k, v]), q),
        match: (o: Row) => (Object.entries(o).forEach(([k, v]) => filters.push([k, v])), q),
        is: (k: string, v: null) => (v === null ? nulls.push(k) : null, q),
        gt: (k: string, v: string) => (gtFilters.push([k, v]), q),
        order: () => q,
        limit: () => q,
        update: (values: Row) => ((upd = values), q),
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown) => {
          if (upd) {
            mocks.updates.push({ table, values: upd });
            return res({ data: null, error: null });
          }
          return res({ data: rows(), error: null });
        },
      };
      return q;
    },
  }),
}));

import {
  cancelCardSetupLink,
  createCardSetupLink,
  getCustomerCardView,
  removeCustomerCard,
} from './customerCards';

const future = new Date(Date.now() + 5 * 86400000).toISOString();

beforeEach(() => {
  vi.resetAllMocks();
  mocks.updates = [];
  mocks.access = { canViewCustomers: true, canEditCustomers: true };
  mocks.tables = {
    customer_cards: [],
    card_setup_links: [],
    organizations: [{ id: 'org-1', name: 'Acme' }],
    business_central_customers: [
      { organization_id: 'org-1', bc_customer_number: 'C1', display_name: 'Cust One', email: 'c@x.com' },
    ],
  };
  mocks.resolveConn.mockResolvedValue({ id: 'conn-1', enabled: true, livemode: false });
  mocks.createLink.mockResolvedValue({ id: 'link-1', url: 'https://app/card-setup/tok', expiresAt: future });
  mocks.sendEmail.mockResolvedValue(undefined);
  mocks.detach.mockResolvedValue({});
});

describe('getCustomerCardView', () => {
  it('stripe off when no enabled default connection', async () => {
    mocks.resolveConn.mockResolvedValue(null);
    expect((await getCustomerCardView('C1')).stripe).toBe('off');
    mocks.resolveConn.mockResolvedValue({ id: 'conn-1', enabled: false, livemode: false });
    expect((await getCustomerCardView('C1')).stripe).toBe('off');
  });

  it('ignores cards from another connection', async () => {
    mocks.tables.customer_cards = [
      { organization_id: 'org-1', stripe_connection_id: 'other', bc_customer_number: 'C1', brand: 'amex', last4: '0005', exp_month: 1, exp_year: 2030, saved_at: 'x', removed_at: null },
      { organization_id: 'org-1', stripe_connection_id: 'conn-1', bc_customer_number: 'C1', brand: 'visa', last4: '4242', exp_month: 8, exp_year: 2028, saved_at: 's', removed_at: null },
      { organization_id: 'org-1', stripe_connection_id: 'conn-1', bc_customer_number: 'C1', brand: 'mc', last4: '1111', exp_month: 1, exp_year: 2030, saved_at: 'x', removed_at: 'y' },
    ];
    const v = await getCustomerCardView('C1');
    expect(v.card).toEqual({ brand: 'visa', last4: '4242', expMonth: 8, expYear: 2028, savedAt: 's' });
    expect(v.stripe).toBe('ready');
    expect(v.canEdit).toBe(true);
  });

  it('returns the open link', async () => {
    mocks.tables.card_setup_links = [
      { organization_id: 'org-1', stripe_connection_id: 'conn-1', bc_customer_number: 'C1', created_at: 'c', expires_at: future, emailed_to: 'a@b.com', canceled_at: null, completed_at: null },
    ];
    expect((await getCustomerCardView('C1')).openLink).toEqual({ createdAt: 'c', expiresAt: future, emailedTo: 'a@b.com' });
  });
});

describe('createCardSetupLink', () => {
  it('without email returns url only', async () => {
    const r = await createCardSetupLink('C1', { email: null });
    expect(r).toEqual({ url: 'https://app/card-setup/tok', expiresAt: future });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.createLink).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ emailedTo: null, connectionId: 'conn-1' }));
  });

  it('with email sends the email and stores emailed_to', async () => {
    await createCardSetupLink('C1', { email: ' c@x.com ' });
    expect(mocks.createLink).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ emailedTo: 'c@x.com' }));
    expect(mocks.sendEmail).toHaveBeenCalledWith({
      to: 'c@x.com',
      organizationName: 'Acme',
      customerName: 'Cust One',
      url: 'https://app/card-setup/tok',
      expiresAt: future,
    });
  });

  it('email failure surfaces an error and leaves no usable link', async () => {
    mocks.sendEmail.mockRejectedValue(new Error('resend down'));
    await expect(createCardSetupLink('C1', { email: 'c@x.com' })).rejects.toThrow(/resend down/);
    expect(mocks.cancelLinks).toHaveBeenCalledWith(expect.anything(), { orgId: 'org-1', connectionId: 'conn-1', bcCustomerNumber: 'C1' });
  });

  it('invalid email rejected', async () => {
    await expect(createCardSetupLink('C1', { email: 'nope' })).rejects.toThrow('Enter a valid email address.');
    expect(mocks.createLink).not.toHaveBeenCalled();
  });

  it('errors when Stripe is not set up', async () => {
    mocks.resolveConn.mockResolvedValue(null);
    await expect(createCardSetupLink('C1', { email: null })).rejects.toThrow(/Stripe isn't set up/);
  });
});

describe('cancel and remove', () => {
  it('cancelCardSetupLink cancels unused links', async () => {
    await cancelCardSetupLink('C1');
    expect(mocks.cancelLinks).toHaveBeenCalledWith(expect.anything(), { orgId: 'org-1', connectionId: 'conn-1', bcCustomerNumber: 'C1' });
  });

  it('removeCustomerCard marks removed and detaches in Stripe', async () => {
    mocks.tables.customer_cards = [
      { id: 'card-1', organization_id: 'org-1', stripe_connection_id: 'conn-1', bc_customer_number: 'C1', stripe_payment_method_id: 'pm_1', removed_at: null },
    ];
    await removeCustomerCard('C1');
    expect(mocks.detach).toHaveBeenCalledWith('pm_1');
    const u = mocks.updates.find((x) => x.table === 'customer_cards')!;
    expect(u.values).toMatchObject({ removed_by: 'u1' });
    expect(typeof u.values.removed_at).toBe('string');
  });
});

describe('permission', () => {
  it('view-only user cannot create/cancel/remove', async () => {
    mocks.access = { canViewCustomers: true, canEditCustomers: false };
    const msg = "You don't have permission to change customers";
    await expect(createCardSetupLink('C1', { email: null })).rejects.toThrow(msg);
    await expect(cancelCardSetupLink('C1')).rejects.toThrow(msg);
    await expect(removeCustomerCard('C1')).rejects.toThrow(msg);
    expect(mocks.createLink).not.toHaveBeenCalled();
    expect(mocks.detach).not.toHaveBeenCalled();
    expect((await getCustomerCardView('C1')).canEdit).toBe(false);
  });
});
