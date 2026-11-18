'use server';

import { revalidatePath } from 'next/cache';
import { createBcClientForOrg } from '@/lib/businessCentral/client';
import { createReferenceTransport } from '@/lib/businessCentral/customerReferences/transport';
import { requireActiveBusinessCentralScope } from '@/lib/businessCentral/environmentScope';
import {
  deleteShipTo,
  pullShipTos,
  saveShipTo,
  setDefaultShipTo,
  type ShipToDeps,
} from '@/lib/businessCentral/shipTo/shipToService';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import type { ShipToRow, ShipToValues } from '@/types/salesOrders';

type Fail = { ok: false; error: string };
type Scope = Awaited<ReturnType<typeof requireActiveBusinessCentralScope>>;

const NO_PERMISSION = "You don't have permission to change customers";

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function revalidateCustomers() {
  revalidatePath('/customers', 'layout');
}

async function editScope(): Promise<Scope | null> {
  const scope = await requireActiveBusinessCentralScope();
  return scope.access.canEditCustomers && scope.access.canViewCustomers ? scope : null;
}

async function viewScope(): Promise<Scope | null> {
  const scope = await requireActiveBusinessCentralScope();
  return scope.access.canViewCustomers ? scope : null;
}

async function buildDeps(scope: Scope): Promise<ShipToDeps> {
  const bc = await createBcClientForOrg(scope.orgId, scope.bcConnectionId);
  const company = await bc.getCompany(bc.config.companyId);
  return {
    supabase: createServiceClient(),
    transport: createReferenceTransport(bc, company.name),
    orgId: scope.orgId,
    connectionId: scope.bcConnectionId,
    now: () => new Date().toISOString(),
  };
}

async function localRows(scope: Scope, customerNumber: string): Promise<ShipToRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('customer_ship_to_addresses')
    .select('*')
    .eq('organization_id', scope.orgId)
    .eq('bc_connection_id', scope.bcConnectionId)
    .eq('customer_number', customerNumber)
    .order('code', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as ShipToRow[];
}

/** A customer's saved ship-to addresses; empty without view permission. */
export async function listShipTos(customerNumber: string): Promise<ShipToRow[]> {
  const scope = await viewScope();
  if (!scope) return [];
  return localRows(scope, customerNumber);
}

export async function saveShipToAction(input: {
  id?: string;
  customerNumber: string;
  code?: string;
  values: ShipToValues;
}): Promise<{ ok: true; row: ShipToRow } | Fail> {
  try {
    const scope = await editScope();
    if (!scope) return { ok: false, error: NO_PERMISSION };
    const row = await saveShipTo(await buildDeps(scope), input);
    revalidateCustomers();
    return { ok: true, row };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

export async function deleteShipToAction(id: string): Promise<{ ok: true } | Fail> {
  try {
    const scope = await editScope();
    if (!scope) return { ok: false, error: NO_PERMISSION };
    await deleteShipTo(await buildDeps(scope), id);
    revalidateCustomers();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

export async function setDefaultShipToAction(customerNumber: string, code: string): Promise<{ ok: true } | Fail> {
  try {
    const scope = await editScope();
    if (!scope) return { ok: false, error: NO_PERMISSION };
    await setDefaultShipTo(await buildDeps(scope), customerNumber, code);
    revalidateCustomers();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/** Pull this customer's ship-tos from BC, then return the local rows. Never throws on a pull failure. */
export async function refreshShipTos(customerNumber: string): Promise<ShipToRow[]> {
  const scope = await viewScope();
  if (!scope) return [];
  try {
    await pullShipTos(await buildDeps(scope), customerNumber);
  } catch (e) {
    console.error('[ship-to] refresh from Business Central failed:', e);
  }
  return localRows(scope, customerNumber);
}
