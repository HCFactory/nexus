import {
  canAccessArtworkWorkspace,
  canViewCustomers,
  canViewReceivables,
  type ResolvedUserAccess,
} from './permissions';

/** Admin only: hidden from everyone else in the sidebar, and the pages send them away. */
const ADMIN_ONLY = ['/dashboard', '/analytics', '/customer-lists'];

/** Where a non-admin lands, first page they can open wins (Customers first: user decision 2026-11-18). */
const LANDING_ORDER = [
  '/customers',
  '/sales-orders',
  '/receivables',
  '/artwork',
  '/orders',
  '/invoices',
  '/shipments',
  '/items',
  '/fnforders',
  '/settings',
];

const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

/** Whether this person may open this page (and see it in the sidebar). */
export function canOpenPath(access: ResolvedUserAccess, path: string): boolean {
  if (access.isAdmin) return true;
  if (ADMIN_ONLY.some((p) => under(path, p))) return false;
  // Purchase Orders section: only for the roles that need each page.
  if (under(path, '/orders') || under(path, '/shipments')) return access.canCreateOrder;
  if (under(path, '/artwork')) return canAccessArtworkWorkspace(access);
  if (under(path, '/invoices')) return access.canViewInvoices;
  if (under(path, '/sales-orders')) return access.canViewSalesOrders;
  if (under(path, '/customers')) return canViewCustomers(access);
  if (under(path, '/receivables')) return canViewReceivables(access);
  return true;
}

/** The page someone lands on after login, or is sent to from a page they can't open. */
export function landingPath(access: ResolvedUserAccess): string {
  if (access.isAdmin) return '/dashboard';
  return LANDING_ORDER.find((p) => canOpenPath(access, p)) ?? '/settings';
}
