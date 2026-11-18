import 'server-only'
import { createBillcomClientForConnection } from '@/lib/billcom/connection'
import { BillcomConnectionDisabledError } from '@/lib/billcom/errors'
import type { BillcomClient } from '@/lib/billcom/client'
import { resolveBillcomConnection } from '@/lib/billcom/customerSyncHooks'
import { createBcClientForOrg } from '@/lib/businessCentral/client'
import { createReferenceTransport } from '@/lib/businessCentral/customerReferences/transport'
import { mirrorSalesInvoice, mirrorSalesInvoiceLines, type InvoiceMirrorDeps } from '@/lib/businessCentral/invoiceMirror'
import type { BcSalesInvoice } from '@/lib/businessCentral/salesInvoiceMapper'
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

  // Invoices of this BC environment reach Bill.com through Bill.com's own BC
  // connector: no Bill.com client at all, so invoicing here never touches Bill.com.
  const billcomViaConnector = (scope.connection as { billcom_via_connector?: boolean } | null)?.billcom_via_connector === true
  const conn = billcomViaConnector ? null : await resolveBillcomConnection(supabase, scope.orgId)
  let billcom: BillcomClient | null = null
  let billcomUnavailable = false
  if (conn?.enabled) {
    try {
      billcom = await createBillcomClientForConnection(conn.id, scope.orgId, { supabase })
    } catch (e) {
      // A broken Bill.com setup must not block BC work (posting, resuming a
      // post): the Bill.com step then fails with the "turned off" message.
      if (!(e instanceof BillcomConnectionDisabledError)) {
        console.error('[invoice] could not create the Bill.com client:', e)
        billcomUnavailable = true
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
    billcomUnavailable,
    billcomViaConnector,
    timeZone: (scope.connection as { time_zone?: string | null } | null)?.time_zone ?? null,
    userId: opts.userId,
    // The posted invoice and its lines, so it shows in Receivables (and its page) at once.
    mirrorPostedInvoice: async (raw) => {
      const mirror: InvoiceMirrorDeps = {
        supabase,
        listResourcePage: (resource, opts) => bc.listResourcePage(resource, opts),
        orgId: scope.orgId,
        connectionId: scope.bcConnectionId,
        environment: bc.config.environment,
        companyId: bc.config.companyId,
        now: () => new Date().toISOString(),
      }
      await mirrorSalesInvoice(mirror, raw as BcSalesInvoice)
      await mirrorSalesInvoiceLines(mirror, String(raw.id))
    },
  }
}
