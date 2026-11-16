import 'server-only'
import { createBillcomClientForConnection } from '@/lib/billcom/connection'
import { BillcomConnectionDisabledError } from '@/lib/billcom/errors'
import type { BillcomClient } from '@/lib/billcom/client'
import { resolveBillcomConnection } from '@/lib/billcom/customerSyncHooks'
import { createBcClientForOrg } from '@/lib/businessCentral/client'
import { createReferenceTransport } from '@/lib/businessCentral/customerReferences/transport'
import { mapBcSalesInvoiceToDb, type BcSalesInvoice } from '@/lib/businessCentral/salesInvoiceMapper'
import { createServiceClient } from '@/lib/supabase/server'
import type { Scope } from './editScope'
import type { InvoiceDeps } from './invoiceProcess'

/**
 * Everything the invoice process needs for the active BC connection: the same
 * BC setup as the order sync (buildDeps in actions/salesOrders.ts, which is a
 * 'use server' file and can't export this), plus invokeAction, the time zone
 * and the org's Bill.com client (null when Bill.com is off or missing).
 */
export async function buildInvoiceDeps(scope: Scope, opts: { userId?: string } = {}): Promise<InvoiceDeps> {
  const bc = await createBcClientForOrg(scope.orgId, scope.bcConnectionId)
  const company = await bc.getCompany(bc.config.companyId)
  const supabase = createServiceClient()

  const conn = await resolveBillcomConnection(supabase, scope.orgId)
  let billcom: BillcomClient | null = null
  if (conn?.enabled) {
    try {
      billcom = await createBillcomClientForConnection(conn.id, scope.orgId, { supabase })
    } catch (e) {
      // A broken Bill.com setup must not block BC work (posting, resuming a
      // post): the Bill.com step then fails with the "turned off" message.
      if (!(e instanceof BillcomConnectionDisabledError)) {
        console.error('[invoice] could not create the Bill.com client:', e)
      }
    }
  }

  return {
    supabase,
    transport: createReferenceTransport(bc, company.name),
    orgId: scope.orgId,
    connectionId: scope.bcConnectionId,
    now: () => new Date().toISOString(),
    invokeAction: (path) => bc.invokeAction(path),
    billcom,
    billcomConnectionId: conn?.id ?? null,
    timeZone: (scope.connection as { time_zone?: string | null } | null)?.time_zone ?? null,
    userId: opts.userId,
    mirrorPostedInvoice: async (raw) => {
      const row = mapBcSalesInvoiceToDb({
        organizationId: scope.orgId,
        connectionId: scope.bcConnectionId,
        environment: bc.config.environment,
        companyId: bc.config.companyId,
        invoice: raw as BcSalesInvoice,
        now: new Date().toISOString(),
      })
      // Same table and conflict target as the Receivables sync (arSyncAdapters).
      const { error } = await supabase
        .from('business_central_sales_invoices')
        .upsert(row, { onConflict: 'organization_id,bc_connection_id,bc_company_id,bc_invoice_id' })
      if (error) throw new Error(error.message)
    },
  }
}
