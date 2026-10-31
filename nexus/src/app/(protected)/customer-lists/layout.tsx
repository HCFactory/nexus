// AppShell clips its content area, so every customer-list page scrolls inside this.
export default function CustomerListsLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>;
}
