import { Check } from 'lucide-react';

/** Success screen after a customer saves a card. No container; shows only the last 4 digits. */
export function CardSavedMessage({ last4 }: { last4: string | null }) {
  return (
    <main className="flex min-h-screen w-full flex-1 flex-col items-center justify-center glass-backdrop px-4 py-10 text-center">
      <div className="flex h-24 w-24 items-center justify-center rounded-full bg-green-600" aria-hidden="true">
        <Check className="h-14 w-14 text-white" strokeWidth={3} />
      </div>
      <h1 className="mt-6 max-w-md text-2xl font-bold text-gray-900 sm:text-3xl">
        {last4 ? `Your card ending in ${last4} was saved!` : 'Your card was saved!'}
      </h1>
      <p className="mt-2 max-w-md text-base text-gray-700">Our team has been notified.</p>
    </main>
  );
}
