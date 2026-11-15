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
    expect(deps).toMatchObject({ billcom: client, billcomConnectionId: 'bcom-1', timeZone: 'America/Chicago' })
  })

  it('a disabled connection gives billcom = null, quietly', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.createBillcomClient.mockRejectedValue(new BillcomConnectionDisabledError('bcom-1'))
    const deps = await buildInvoiceDeps(scope)
    expect(deps).toMatchObject({ billcom: null, billcomConnectionId: 'bcom-1' })
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
    expect(deps).toMatchObject({ billcom: null, billcomConnectionId: 'bcom-1', connectionId: 'conn-1' })
    expect(typeof deps.invokeAction).toBe('function')
    expect(logged).toHaveBeenCalledTimes(1)
    logged.mockRestore()
  })

  it('Bill.com off: billcom = null without trying to create a client', async () => {
    mocks.resolveConn.mockResolvedValue({ id: 'bcom-1', enabled: false })
    const deps = await buildInvoiceDeps(scope)
    expect(deps).toMatchObject({ billcom: null, billcomConnectionId: 'bcom-1' })
    expect(mocks.createBillcomClient).not.toHaveBeenCalled()
  })
})
