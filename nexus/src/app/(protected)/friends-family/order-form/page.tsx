import { getFriendsFamilyWorkspace } from '@/app/actions/friendsFamilyOrders';
import { getCurrentUser } from '@/app/actions/users';
import { FriendsFamilyOrderForm } from '@/components/friendsFamily/FriendsFamilyOrderForm';

export const dynamic = 'force-dynamic';

export default async function FriendsFamilyStandaloneOrderFormPage() {
  const user = await getCurrentUser();

  if (!user?.organization_id) {
    return (
      <main className="flex flex-1 items-center justify-center bg-background">
        <p className="text-sm text-foreground-muted">An organization membership is required.</p>
      </main>
    );
  }

  const workspace = await getFriendsFamilyWorkspace();

  return (
    <main className="flex-1 overflow-y-auto bg-background px-3 py-5 lg:p-8">
      <div className="mx-auto max-w-5xl">
        <FriendsFamilyOrderForm products={workspace.products} standalone />
      </div>
    </main>
  );
}
