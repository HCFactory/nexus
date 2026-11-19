import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/app/actions/users';
import { landingPath } from '@/lib/auth/pageAccess';
import { resolveUserAccess } from '@/lib/auth/permissions';

// Admins land on Dashboard; everyone else on Customers, or the first page they can open.
export default async function HomePage() {
  const user = await getCurrentUser();
  redirect(user ? landingPath(resolveUserAccess(user)) : '/login');
}
