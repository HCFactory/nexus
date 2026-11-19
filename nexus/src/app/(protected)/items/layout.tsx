import { guardPage } from '@/lib/auth/pageGuard';

// Admin only: everyone else is sent to their landing page.
export default async function Layout({ children }: { children: React.ReactNode }) {
  await guardPage('/items');
  return children;
}
