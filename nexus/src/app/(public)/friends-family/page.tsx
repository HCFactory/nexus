import { getFriendsFamilyWorkspace } from '@/app/actions/friendsFamilyOrders';
import { getCurrentUser } from '@/app/actions/users';
import { FriendsFamilyOrdersClient } from '@/components/friendsFamily/FriendsFamilyOrdersClient';

export const dynamic = 'force-dynamic';

export default async function FriendsFamilyOrdersPage() {
  const user = await getCurrentUser();
  const workspace = await getFriendsFamilyWorkspace();

  return (
    <FriendsFamilyOrdersClient
      initialWorkspace={workspace}
      isAdmin={user?.role === 'admin'}
    />
  );
}
