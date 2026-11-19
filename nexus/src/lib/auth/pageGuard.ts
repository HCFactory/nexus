import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/app/actions/users';

import { canOpenPath, landingPath } from './pageAccess';
import { resolveUserAccess } from './permissions';

/**
 * For a page's layout: someone who may not open `path` is sent to their landing
 * page. No user: does nothing (the protected layout sends them to login).
 */
export async function guardPage(path: string): Promise<void> {
  const user = await getCurrentUser();
  if (!user) return;
  const access = resolveUserAccess(user);
  if (!canOpenPath(access, path)) redirect(landingPath(access));
}
