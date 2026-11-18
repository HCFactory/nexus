import type { Metadata } from 'next';

// Customers see these pages on the company's own payment address: never show
// the app's name or description, and keep the private links out of search.
export const metadata: Metadata = {
  title: 'Save your card',
  description: 'Securely save a card for future invoice payments.',
  robots: { index: false, follow: false },
};

export default function CardSetupLayout({ children }: { children: React.ReactNode }) {
  return children;
}
