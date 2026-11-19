import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { User } from '@/types/database';
import { AppNav } from './AppNav';

vi.mock('next/navigation', () => ({ usePathname: () => '/customers' }));
afterEach(cleanup);

const user = (over: Partial<User>): User => ({
  id: 'u', email: 'u@x.com', display_name: 'U', role: 'user', organization_id: 'org-1', active_bc_connection_id: null,
  permissions: null, permissions_version: 1, permissions_updated_at: null, created_at: '', updated_at: '', ...over,
});
const links = () => screen.getAllByRole('link').map((a) => a.textContent?.trim());

describe('AppNav by role', () => {
  it('admins see Dashboard, Analytics, Purchase Orders and Customer lists', () => {
    render(<AppNav user={user({ role: 'admin' })} />);
    for (const l of ['Dashboard', 'Analytics', 'Orders', 'Artwork', 'Purchase invoices', 'Shipments', 'Customer lists']) expect(links()).toContain(l);
  });

  it('a vendor sees Artwork but not Dashboard, Analytics, Orders, Shipments or Customer lists', () => {
    render(<AppNav user={user({ permissions: { functionalRoles: { purchaser: false, vendor: true, designer: 'disabled' }, overrides: {} } })} />);
    expect(links()).toContain('Artwork');
    for (const l of ['Dashboard', 'Analytics', 'Orders', 'Shipments', 'Purchase invoices', 'Customer lists']) expect(links()).not.toContain(l);
    expect(screen.queryByText('Purchase Orders')).toBeInTheDocument(); // the section stays for Artwork
  });

  it('a non-admin with none of those roles sees no Purchase Orders section at all', () => {
    render(<AppNav user={user({ permissions: { functionalRoles: { purchaser: false, vendor: false, designer: 'disabled' }, overrides: { viewCustomers: true } } })} />);
    expect(screen.queryByText('Purchase Orders')).toBeNull();
    expect(links()).toContain('Customers');
    expect(links()).not.toContain('Customer lists');
  });
});
