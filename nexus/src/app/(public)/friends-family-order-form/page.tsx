import { getFriendsFamilyWorkspace } from '@/app/actions/friendsFamilyOrders';
import { FriendsFamilyOrderForm } from '@/components/friendsFamily/FriendsFamilyOrderForm';

export const dynamic = 'force-dynamic';

export default async function FriendsFamilyStandaloneOrderFormPage() {
  const workspace = await getFriendsFamilyWorkspace();

  return (
    <main className="flex w-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-background px-3 py-5 lg:p-8">
      <div className="mx-auto w-full min-w-0 max-w-5xl lg:max-w-[51.2rem]">
        <FriendsFamilyOrderForm products={workspace.products} standalone />
      </div>
    </main>
  );
}
