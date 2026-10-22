import { redirect } from 'next/navigation';
import { UserList } from '@/components/admin';
import { BcCredentialsCard } from '@/components/businessCentral/BcCredentialsCard';
import { BcEnvironmentsCard } from '@/components/businessCentral/BcEnvironmentsCard';
import { BillcomConnectionsCard } from '@/components/billcom/BillcomConnectionsCard';
import { getAllUsers, changeUserPassword, getCurrentUser, updateUserAccess } from '@/app/actions/users';
import { resolveUserAccess } from '@/lib/auth/permissions';

export default async function AdminPage() {
  const currentUser = await getCurrentUser();
  const access = resolveUserAccess(currentUser);

  if (!currentUser || !access.canManageUsers) {
    redirect('/');
  }

  const users = await getAllUsers();

  return (
    <div className="flex flex-col flex-1 overflow-y-auto bg-background">
      <main className="max-w-6xl mx-auto p-6 w-full">
        <div className="mb-8">
          <h1 className="text-xl lg:text-2xl font-bold text-foreground">User Management</h1>
          <p className="text-foreground-muted mt-1">
            Manage organization-scoped roles, permissions, assignments, and passwords.
          </p>
        </div>

        <UserList
          users={users}
          onChangePassword={changeUserPassword}
          onUpdateUserAccess={updateUserAccess}
        />

        <div className="mt-10">
          <h2 className="text-xl lg:text-2xl font-bold text-foreground">Business Central</h2>
          <p className="text-foreground-muted mt-1">
            Shared connection credentials and the environments your organization syncs with.
          </p>
          <BcCredentialsCard />
          <BcEnvironmentsCard />
        </div>

        <div className="mt-10">
          <h2 className="text-xl lg:text-2xl font-bold text-foreground">Bill.com</h2>
          <p className="text-foreground-muted mt-1">
            Accounts-receivable connections. Disabled by default; nothing syncs until enabled.
          </p>
          <BillcomConnectionsCard />
        </div>
      </main>
    </div>
  );
}
