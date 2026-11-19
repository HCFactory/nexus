import { describe, expect, it } from 'vitest';

import { canOpenPath, landingPath } from './pageAccess';
import { resolveUserAccess } from './permissions';
import type { User } from '@/types/database';

const user = (over: Partial<User> = {}): User => ({
  id: 'u', email: 'u@x.com', display_name: 'U', role: 'user', organization_id: 'org-1', active_bc_connection_id: null,
  permissions: null, permissions_version: 1, permissions_updated_at: null, created_at: '', updated_at: '', ...over,
});
const withRoles = (roles: { purchaser?: boolean; vendor?: boolean; designer?: 'disabled' | 'view' | 'edit' }, overrides = {}) =>
  resolveUserAccess(user({ permissions: { functionalRoles: { purchaser: false, vendor: false, designer: 'disabled', ...roles }, overrides } }));

const admin = resolveUserAccess(user({ role: 'admin' }));
const plain = withRoles({});
const purchaser = withRoles({ purchaser: true });
const vendor = withRoles({ vendor: true });
const designer = withRoles({ designer: 'view' });
const customersUser = withRoles({}, { viewCustomers: true });

describe('canOpenPath', () => {
  it('admins can open everything', () => {
    for (const p of ['/dashboard', '/analytics', '/customer-lists', '/customer-lists/paymentTerms', '/orders', '/shipments', '/artwork', '/invoices']) {
      expect(canOpenPath(admin, p)).toBe(true);
    }
  });

  it('non-admins never open Dashboard, Analytics, Customer lists or Items (and their sub-pages)', () => {
    for (const a of [plain, purchaser, vendor, designer, customersUser]) {
      for (const p of ['/dashboard', '/analytics', '/customer-lists', '/customer-lists/tax-areas', '/items', '/items/abc']) expect(canOpenPath(a, p)).toBe(false);
    }
  });

  it('Purchase Orders pages only when the role needs them', () => {
    expect([canOpenPath(purchaser, '/orders'), canOpenPath(purchaser, '/shipments'), canOpenPath(purchaser, '/invoices')]).toEqual([true, true, true]);
    expect(canOpenPath(purchaser, '/artwork')).toBe(false);
    expect([canOpenPath(vendor, '/artwork'), canOpenPath(designer, '/artwork')]).toEqual([true, true]);
    for (const p of ['/orders', '/shipments', '/invoices']) {
      expect(canOpenPath(vendor, p)).toBe(false);
      expect(canOpenPath(designer, p)).toBe(false);
      expect(canOpenPath(plain, p)).toBe(false);
    }
  });

  it('keeps the existing customer / receivables rules, and does not confuse /receivables/invoices with /invoices', () => {
    expect(canOpenPath(customersUser, '/customers')).toBe(true);
    expect(canOpenPath(plain, '/customers')).toBe(false);
    expect(canOpenPath(purchaser, '/receivables/invoices')).toBe(false);
    expect(canOpenPath(admin, '/items')).toBe(true);
    expect(canOpenPath(plain, '/settings')).toBe(true);
  });
});

describe('landingPath', () => {
  it('admins land on Dashboard; non-admins on Customers, else the first page they can open', () => {
    expect(landingPath(admin)).toBe('/dashboard');
    expect(landingPath(customersUser)).toBe('/customers');
    expect(landingPath(vendor)).toBe('/artwork');
    expect(landingPath(purchaser)).toBe('/orders');
    expect(landingPath(plain)).toBe('/fnforders');
  });
});
