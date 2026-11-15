export default function ShipmentsPage() {
  return (
    <main className="flex-1 flex items-center justify-center">
      <div className="text-center">
        <svg className="w-16 h-16 mx-auto text-foreground-subtle mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
        </svg>
        <h1 className="text-xl lg:text-2xl font-bold text-foreground mb-2">Shipments</h1>
        <p className="text-foreground-muted">Coming soon</p>
      </div>
    </main>
  );
}
