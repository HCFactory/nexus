import { getCurrentUserAccessContext } from '@/lib/auth/currentUserAccess';
import { getActiveBusinessCentralScope } from '@/lib/businessCentral/environmentScope';
import type { ResolvedUserAccess } from '@/lib/auth/permissions';

export type SalesOrderPageAccess =
  | { ok: true; access: ResolvedUserAccess }
  | { ok: false; title: string; message: string };

/** Who may see the sales order pages, and whether a Business Central environment is selected. */
export async function resolveSalesOrderPageAccess(): Promise<SalesOrderPageAccess> {
  const context = await getCurrentUserAccessContext();
  if (!context) return { ok: false, title: 'Not signed in', message: 'Sign in to see sales orders.' };
  if (!context.user.organization_id) {
    return {
      ok: false,
      title: 'No organization assigned',
      message: 'Your account is not linked to an organization. Ask your administrator to assign you to one.',
    };
  }
  if (!context.access.canViewSalesOrders) {
    return { ok: false, title: 'No access', message: "You don't have permission to view sales orders." };
  }
  const scope = await getActiveBusinessCentralScope().catch(() => null);
  if (!scope?.bcConnectionId) {
    return {
      ok: false,
      title: 'No Business Central environment',
      message: 'Select a Business Central environment first.',
    };
  }
  return { ok: true, access: context.access };
}

export function SalesOrderPageNotice({ title, message }: { title: string; message: string }) {
  return (
    <main className="flex flex-1 items-center justify-center bg-background p-6">
      <div className="max-w-sm text-center">
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        <p className="mt-2 text-sm text-foreground-muted">{message}</p>
      </div>
    </main>
  );
}
