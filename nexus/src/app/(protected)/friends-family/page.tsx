import { getFriendsFamilyWorkspace } from '@/app/actions/friendsFamilyOrders';
import { getCurrentUser } from '@/app/actions/users';
import { FriendsFamilyOrdersClient } from '@/components/friendsFamily/FriendsFamilyOrdersClient';

export const dynamic = 'force-dynamic';

export default async function FriendsFamilyOrdersPage() {
  const user = await getCurrentUser();

  if (!user) {
    return (
      <main className="flex flex-1 items-center justify-center bg-background">
        <div className="text-foreground-muted">Not authenticated</div>
      </main>
    );
  }

  if (!user.organization_id) {
    return (
      <main className="flex flex-1 items-center justify-center bg-background">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold text-foreground">No organization assigned</h1>
          <p className="mt-2 text-sm text-foreground-muted">
            Ask an administrator to assign your account to an organization before creating orders.
          </p>
        </div>
      </main>
    );
  }

  const workspace = await getFriendsFamilyWorkspace();

  return (
    <FriendsFamilyOrdersClient
      initialWorkspace={workspace}
      isAdmin={user.role === 'admin'}
    />
  );
}
