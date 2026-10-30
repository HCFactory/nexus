import { getCurrentUser } from '@/app/actions/users';
import { LightOnlyTheme } from '@/components/friendsFamily/LightOnlyTheme';

export const dynamic = 'force-dynamic';

export default async function PublicFriendsFamilyLayout({ children }: { children: React.ReactNode }) {
  // Signed-in users keep their own theme choice; everyone else sees light mode.
  const user = await getCurrentUser();
  if (user) return <>{children}</>;

  return <LightOnlyTheme>{children}</LightOnlyTheme>;
}
