import { guardPage } from '@/lib/auth/pageGuard';

// Non-admins who may not open this page are sent to their landing page.
export default async function Layout({ children }: { children: React.ReactNode }) {
  await guardPage('/dashboard');
  return children;
}
