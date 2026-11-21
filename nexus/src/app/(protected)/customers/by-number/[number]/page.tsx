import { redirect } from 'next/navigation';

import { requirePermission } from '@/lib/auth/currentUserAccess';
import { canViewCustomers } from '@/lib/auth/permissions';
import { resolveActiveBcConnection } from '@/lib/businessCentral/activeConnection';
import { customerProfilePath } from '@/lib/customers/customerProfilePath';
import { createServiceClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/** /customers/by-number/W00123 → that customer's profile in the active environment. */
export default async function CustomerByNumberPage({ params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  const { orgId, user } = await requirePermission(canViewCustomers, 'You do not have permission to view customers');
  const connection = await resolveActiveBcConnection(orgId, user.id);
  redirect(await customerProfilePath(createServiceClient(), orgId, connection?.id ?? null, decodeURIComponent(number)));
}
