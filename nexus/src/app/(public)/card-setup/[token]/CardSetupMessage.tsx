/** A plain centered message for the public card-setup pages. Shows no customer details. */
export function CardSetupMessage({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen w-full flex-1 items-center justify-center glass-backdrop px-4 py-10">
      <p className="max-w-md rounded-2xl border border-black/10 bg-white/80 px-6 py-5 text-center text-base text-gray-900 shadow-sm">
        {children}
      </p>
    </main>
  );
}
