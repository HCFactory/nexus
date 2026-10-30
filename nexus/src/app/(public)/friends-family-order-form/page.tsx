import { getFriendsFamilyWorkspace } from '@/app/actions/friendsFamilyOrders';
import { FriendsFamilyOrderForm } from '@/components/friendsFamily/FriendsFamilyOrderForm';

export const dynamic = 'force-dynamic';

export default async function FriendsFamilyStandaloneOrderFormPage() {
  const workspace = await getFriendsFamilyWorkspace();

  return (
    <main className="flex-1 overflow-y-auto bg-background px-3 py-5 lg:p-8">
      <div className="mx-auto max-w-5xl">
        <FriendsFamilyOrderForm products={workspace.products} standalone />
      </div>
    </main>
  );
}
