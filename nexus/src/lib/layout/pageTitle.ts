/** The top bar title for a page, from the first part of its address. */
export function pageTitle(pathname: string): string {
  if (pathname === '/') return 'Dashboard';
  const segment = pathname.split('/').filter(Boolean)[0] ?? '';
  if (segment === 'admin') return 'Admin Panel';
  // Matches the sidebar's "Sales" section.
  if (segment === 'receivables') return 'Sales';
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}
