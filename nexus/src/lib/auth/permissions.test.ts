import { describe, expect, it } from 'vitest';

import { DEFAULT_FUNCTIONAL_ROLES, resolveUserAccess, summarizeEffectiveAccess } from './permissions';
import { User } from '@/types/database';

const baseUser: User = {
  id: 'user-1',
  email: 'user@example.com',
  display_name: 'Test User',
  role: 'user',
  organization_id: 'org-1',
  active_bc_connection_id: null,
  permissions: null,
  permissions_version: 1,
  permissions_updated_at: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

describe('resolveUserAccess invoice permissions', () => {
  it('grants all invoice capabilities to admins', () => {
    const access = resolveUserAccess({ ...baseUser, role: 'admin' });

    expect(access.canViewInvoices).toBe(true);
    expect(access.canCreateInvoices).toBe(true);
    expect(access.canEditInvoices).toBe(true);
    expect(access.canDeleteInvoices).toBe(true);
    expect(access.canAssignInvoices).toBe(true);
  });

  it('grants invoice defaults to purchasers', () => {
    const access = resolveUserAccess({
      ...baseUser,
      permissions: {
        functionalRoles: { purchaser: true, vendor: false, designer: 'disabled' },
        overrides: {},
      },
    });

    expect(access.canViewInvoices).toBe(true);
    expect(access.canCreateInvoices).toBe(true);
    expect(access.canEditInvoices).toBe(true);
    expect(access.canDeleteInvoices).toBe(true);
    expect(access.canAssignInvoices).toBe(true);
  });

  it('keeps vendor/designer-only users out of invoice capabilities by default', () => {
    const access = resolveUserAccess({
      ...baseUser,
      permissions: {
        functionalRoles: { purchaser: false, vendor: true, designer: 'edit' },
        overrides: {},
      },
    });

    expect(access.canViewInvoices).toBe(false);
    expect(access.canCreateInvoices).toBe(false);
    expect(access.canEditInvoices).toBe(false);
    expect(access.canDeleteInvoices).toBe(false);
    expect(access.canAssignInvoices).toBe(false);
  });

  it('allows overrides but does not allow assign without view', () => {
    const access = resolveUserAccess({
      ...baseUser,
      permissions: {
        functionalRoles: { purchaser: false, vendor: false, designer: 'disabled' },
        overrides: {
          viewInvoices: false,
          assignInvoices: true,
        },
      },
    });

    expect(access.canViewInvoices).toBe(false);
    expect(access.canAssignInvoices).toBe(false);
  });
});

describe('receivables permissions', () => {
  it('denies customers and receivables to a default non-admin user', () => {
    const access = resolveUserAccess({ role: 'user', permissions: null });
    expect(access.canViewCustomers).toBe(false);
    expect(access.canViewReceivables).toBe(false);
  });

  it('grants both to an admin', () => {
    const access = resolveUserAccess({ role: 'admin', permissions: null });
    expect(access.canViewCustomers).toBe(true);
    expect(access.canViewReceivables).toBe(true);
  });

  it('honours per-user overrides independently', () => {
    const access = resolveUserAccess({
      role: 'user',
      permissions: { functionalRoles: DEFAULT_FUNCTIONAL_ROLES, overrides: { viewCustomers: true } },
    });
    expect(access.canViewCustomers).toBe(true);
    expect(access.canViewReceivables).toBe(false);
  });
});

describe('canEditCustomers permission', () => {
  it('is listed in ACCESS_KEYS', () => {
    const access = resolveUserAccess({ role: 'admin', permissions: null });
    expect(summarizeEffectiveAccess(access)).toContain('Edit Customers');
  });

  it('is true for admins and false by default for others', () => {
    expect(resolveUserAccess({ role: 'admin', permissions: null }).canEditCustomers).toBe(true);
    expect(resolveUserAccess({ role: 'user', permissions: null }).canEditCustomers).toBe(false);
  });

  it('is true when the per-user override is set', () => {
    const access = resolveUserAccess({
      role: 'user',
      permissions: { functionalRoles: DEFAULT_FUNCTIONAL_ROLES, overrides: { editCustomers: true } },
    });
    expect(access.canEditCustomers).toBe(true);
    expect(access.canViewCustomers).toBe(false);
  });
});
