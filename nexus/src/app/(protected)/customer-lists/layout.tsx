import { guardPage } from '@/lib/auth/pageGuard';

// AppShell clips its content area. The list pages fill this height so only their
// table scrolls; anything taller (an open form, the tax area page) scrolls here.
export default async function CustomerListsLayout({ children }: { children: React.ReactNode }) {
  // Admin only: everyone else is sent to their landing page.
  await guardPage('/customer-lists');
  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-5">{children}</div>;
}
