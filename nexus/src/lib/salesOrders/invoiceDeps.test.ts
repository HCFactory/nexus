import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createBillcomClient: vi.fn(),
  resolveConn: vi.fn(),
  createBcClientForOrg: vi.fn(),
  createTransport: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/billcom/connection', () => ({ createBillcomClientForConnection: mocks.createBillcomClient }))
vi.mock('@/lib/billcom/customerSyncHooks', () => ({ resolveBillcomConnection: mocks.resolveConn }))
vi.mock('@/lib/businessCentral/client', () => ({ createBcClientForOrg: mocks.createBcClientForOrg }))
vi.mock('@/lib/businessCentral/customerReferences/transport', () => ({ createReferenceTransport: mocks.createTransport }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.createServiceClient }))

import { BillcomApiError, BillcomConnectionDisabledError } from '@/lib/billcom/errors'
import type { Scope } from './editScope'
import { buildInvoiceDeps } from './invoiceDeps'

const scope = { orgId: 'org-1', bcConnectionId: 'conn-1', connection: { time_zone: 'America/Chicago' } } as unknown as Scope
const client = { request: vi.fn() }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.createBcClientForOrg.mockResolvedValue({
    config: { companyId: 'c1' },
    getCompany: vi.fn(async () => ({ name: 'CRONUS' })),
    invokeAction: vi.fn(),
  })
  mocks.createTransport.mockReturnValue({ transport: true })
  mocks.createServiceClient.mockReturnValue({ supabase: true })
  mocks.resolveConn.mockResolvedValue({ id: 'bcom-1', enabled: true })
  mocks.createBillcomClient.mockResolvedValue(client)
})

describe('buildInvoiceDeps: Bill.com client', () => {
  it('uses the Bill.com client when it can be created', async () => {
    const deps = await buildInvoiceDeps(scope)
    expect(deps).toMatchObject({ billcom: client, billcomConnectionId: 'bcom-1', timeZone: 'America/Chicago', billcomUnavailable: false })
  })

  it('a disabled connection gives billcom = null, quietly', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.createBillcomClient.mockRejectedValue(new BillcomConnectionDisabledError('bcom-1'))
    const deps = await buildInvoiceDeps(scope)
    expect(deps).toMatchObject({ billcom: null, billcomConnectionId: 'bcom-1', billcomUnavailable: false })
    expect(logged).not.toHaveBeenCalled()
    logged.mockRestore()
  })

  it.each([
    ['a plain error', new Error('Could not decrypt the Bill.com credentials')],
    ['a Bill.com API error', new BillcomApiError({ status: 500, statusText: 'Server Error', message: 'down', url: '' })],
  ])('%s creating the client is logged and gives billcom = null, so BC work is not blocked', async (_label, err) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.createBillcomClient.mockRejectedValue(err)
    const deps = await buildInvoiceDeps(scope)
    // Turned on but broken is not 'off': Bill.com work must fail visibly, never be skipped.
    expect(deps).toMatchObject({ billcom: null, billcomConnectionId: 'bcom-1', connectionId: 'conn-1', billcomUnavailable: true })
    expect(typeof deps.invokeAction).toBe('function')
    expect(logged).toHaveBeenCalledTimes(1)
    logged.mockRestore()
  })

  it('Bill.com off: billcom = null without trying to create a client', async () => {
    mocks.resolveConn.mockResolvedValue({ id: 'bcom-1', enabled: false })
    const deps = await buildInvoiceDeps(scope)
    expect(deps).toMatchObject({ billcom: null, billcomConnectionId: 'bcom-1', billcomUnavailable: false })
    expect(mocks.createBillcomClient).not.toHaveBeenCalled()
  })
})

describe('buildInvoiceDeps: Bill.com via its BC connector', () => {
  it("never builds a Bill.com client for an environment whose invoices come through Bill.com's connector", async () => {
    const via = { ...scope, connection: { time_zone: 'America/Chicago', billcom_via_connector: true } } as unknown as Scope
    const deps = await buildInvoiceDeps(via)
    expect(deps).toMatchObject({ billcom: null, billcomConnectionId: null, billcomUnavailable: false, billcomViaConnector: true })
    expect(mocks.createBillcomClient).not.toHaveBeenCalled()
  })

  it('is off by default', async () => {
    expect((await buildInvoiceDeps(scope)).billcomViaConnector).toBe(false)
  })
})

describe('buildInvoiceDeps: mirrorPostedInvoice', () => {
  it('copies the posted invoice and its lines into Receivables', async () => {
    const upserts: Array<[string, unknown]> = []
    mocks.createServiceClient.mockReturnValue({
      from: (table: string) => ({
        upsert: (rows: unknown) => {
          upserts.push([table, rows])
          const res = { data: rows, error: null }
          return { select: () => ({ single: async () => ({ data: rows, error: null }), then: (r: (v: typeof res) => unknown) => Promise.resolve(res).then(r) }) }
        },
      }),
    })
    const listResourcePage = vi.fn(async () => [{ id: 'l1', documentId: 'inv-guid' }])
    mocks.createBcClientForOrg.mockResolvedValue({
      config: { companyId: 'c1', environment: 'TEST' },
      getCompany: vi.fn(async () => ({ name: 'CRONUS' })),
      invokeAction: vi.fn(),
      listResourcePage,
    })
    const deps = await buildInvoiceDeps(scope)
    await deps.mirrorPostedInvoice!({ id: 'inv-guid', number: 'INV-1', status: 'Open' })
    expect(upserts.map(([t]) => t)).toEqual(['business_central_sales_invoices', 'business_central_sales_invoice_lines'])
    expect(listResourcePage).toHaveBeenCalledWith('salesInvoiceLines', { filter: 'documentId eq inv-guid', top: 500 })
  })
})
