import { requireActiveBusinessCentralScope } from '@/lib/businessCentral/environmentScope';

export type Fail = { ok: false; error: string };
export type Scope = Awaited<ReturnType<typeof requireActiveBusinessCentralScope>>;

export const NO_PERMISSION = "You don't have permission to change sales orders";

/** The active Business Central scope, or null when the user can't edit sales orders. */
export async function editScope(): Promise<Scope | null> {
  const scope = await requireActiveBusinessCentralScope();
  return scope.access.canEditSalesOrders && scope.access.canViewSalesOrders ? scope : null;
}
