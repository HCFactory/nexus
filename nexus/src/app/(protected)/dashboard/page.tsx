import { LayoutGrid } from 'lucide-react';

export default function DashboardPage() {
  return (
    <main className="flex-1 flex items-center justify-center">
      <div className="text-center">
        <LayoutGrid className="w-16 h-16 mx-auto text-foreground-subtle mb-4" />
        <h1 className="text-xl lg:text-2xl font-bold text-foreground mb-2">Dashboard</h1>
        <p className="text-foreground-muted">Coming soon</p>
      </div>
    </main>
  );
}
