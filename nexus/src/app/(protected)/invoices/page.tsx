import { getInvoiceWorkspaceData } from '@/app/actions/invoices';
import { getCurrentUser } from '@/app/actions/users';
import { InvoicesClient } from '@/components/invoices/InvoicesClient';
import { resolveUserAccess } from '@/lib/auth/permissions';
import { InvoiceWorkspaceData } from '@/types/database';

export const dynamic = 'force-dynamic';

const EMPTY_DATA: InvoiceWorkspaceData = {
  invoices: [],
  eligible_items: {
    supplier: [],
    manufacturer: [],
  },
};

export default async function InvoicesPage() {
  const user = await getCurrentUser();
  const access = resolveUserAccess(user);
  let data = EMPTY_DATA;

  if (user?.organization_id && access.canViewInvoices) {
    try {
      data = await getInvoiceWorkspaceData();
    } catch (error) {
      console.error('Failed to load invoices:', error);
    }
  }

  if (!user) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <div className="text-foreground-muted">Not authenticated</div>
      </main>
    );
  }

  if (!user.organization_id) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold text-foreground">No organization assigned</h1>
          <p className="mt-2 text-sm text-foreground-muted">
            Your account is not linked to an organization. Ask your administrator to assign you to one before using invoices.
          </p>
        </div>
      </main>
    );
  }

  return <InvoicesClient initialData={data} access={access} />;
}
