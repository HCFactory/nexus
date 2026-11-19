import { redirect } from 'next/navigation';
import { UserList } from '@/components/admin';
import { SyncSection } from '@/components/admin/SyncSection';
import { getSyncOverview } from '@/app/actions/syncAdmin';
import { BcCredentialsCard } from '@/components/businessCentral/BcCredentialsCard';
import { BcEnvironmentsCard } from '@/components/businessCentral/BcEnvironmentsCard';
import { BillcomConnectionsCard } from '@/components/billcom/BillcomConnectionsCard';
import { StripeConnectionsCard } from '@/components/stripe/StripeConnectionsCard';
import { getAllUsers, changeUserPassword, getCurrentUser, updateUserAccess } from '@/app/actions/users';
import { getUserOrganizations } from '@/app/actions/organizations';
import { resolveUserAccess } from '@/lib/auth/permissions';

export default async function AdminPage() {
  const currentUser = await getCurrentUser();
  const access = resolveUserAccess(currentUser);

  if (!currentUser || !access.canManageUsers) {
    redirect('/');
  }

  const [users, syncOverview] = await Promise.all([getAllUsers(), getSyncOverview()]);
  const orgs = await getUserOrganizations(currentUser.id).catch(() => []);
  const own = orgs.find((o) => o.id === currentUser.organization_id) ?? orgs[0];
  const organization = currentUser.organization_id
    ? { id: currentUser.organization_id, name: own?.name ?? 'this organization' }
    : null;

  return (
    <div className="flex flex-col flex-1 overflow-y-auto">
      <main className="max-w-6xl mx-auto p-6 w-full">
        <div className="mb-10">
          <h1 className="text-xl lg:text-2xl font-bold text-foreground">Sync</h1>
          <p className="text-foreground-muted mt-1 mb-4">
            Copy data from Business Central into Nexus for the environment you&apos;re on. Syncs only read from Business Central.
          </p>
          <SyncSection overview={syncOverview} />
        </div>

        <div className="mb-8">
          <h1 className="text-xl lg:text-2xl font-bold text-foreground">User Management</h1>
          <p className="text-foreground-muted mt-1">
            Manage organization-scoped roles, permissions, assignments, and passwords.
          </p>
        </div>

        <UserList
          users={users}
          organization={organization}
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

        <div className="mt-10">
          <h2 className="text-xl lg:text-2xl font-bold text-foreground">Stripe</h2>
          <p className="text-foreground-muted mt-1">
            Saved-card payments. Disabled by default; nothing contacts Stripe until enabled.
          </p>
          <StripeConnectionsCard />
        </div>
      </main>
    </div>
  );
}
