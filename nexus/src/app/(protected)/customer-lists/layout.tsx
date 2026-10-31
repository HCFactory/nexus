// AppShell clips its content area. The list pages fill this height so only their
// table scrolls; anything taller (an open form, the tax area page) scrolls here.
export default function CustomerListsLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>;
}
