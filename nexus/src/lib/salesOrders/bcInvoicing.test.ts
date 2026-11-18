import { describe, expect, it, vi } from 'vitest'
import type { BcRecord, ReferenceSource, ReferenceTransport } from '@/lib/businessCentral/customerReferences/transport'
import { BcApiError } from '@/lib/businessCentral/client'
import { BcPostOutcomeUnknownError, BcPostRefusedError, findPostedInvoice, postShipAndInvoice, setInvoiceDates, type BcInvoicingDeps } from './bcInvoicing'

const rec = (fields: Record<string, unknown>, etag = 'W/"1"'): BcRecord => ({
  key: { bcId: String(fields.id ?? 'x') },
  etag,
  fields,
})

const INVOICE = {
  id: 'inv-guid',
  number: 'PSI-100',
  orderNumber: 'W-100501',
  externalDocumentNumber: 'PO-9',
  invoiceDate: '2026-11-15',
  dueDate: '2026-12-15',
  totalAmountExcludingTax: 100,
  totalTaxAmount: 8.25,
  totalAmountIncludingTax: 108.25,
}

function makeDeps(opts: {
  list?: (source: ReferenceSource, o?: { filter?: string }) => BcRecord[] | Promise<BcRecord[]>
  invokeAction?: (p: string) => Promise<void>
} = {}) {
  const list = vi.fn(async (s: ReferenceSource, o?: { filter?: string; select?: string[] }) =>
    opts.list ? opts.list(s, o) : [],
  )
  const get = vi.fn(async () => rec({ No: 'W-100501' }, 'W/"fresh"'))
  const patch = vi.fn(async () => rec({}))
  const transport = { list, get, patch, create: vi.fn(), remove: vi.fn() } as unknown as ReferenceTransport
  const invokeAction = vi.fn(opts.invokeAction ?? (async () => undefined))
  const deps = {
    supabase: {} as never,
    transport,
    orgId: 'o',
    connectionId: 'c',
    now: () => 'now',
    invokeAction,
  } as BcInvoicingDeps
  return { deps, list, get, patch, invokeAction }
}

const q = { orderNumber: 'W-100501', externalDocumentNumber: "PO-9'x", customerNumber: 'C1' }

describe('findPostedInvoice', () => {
  it('maps the invoice found by order number', async () => {
    const { deps, list } = makeDeps({ list: () => [rec(INVOICE)] })
    const inv = await findPostedInvoice(deps, q)
    expect(inv).toMatchObject({
      id: 'inv-guid',
      number: 'PSI-100',
      invoiceDate: '2026-11-15',
      dueDate: '2026-12-15',
      totalExclTax: 100,
      totalTax: 8.25,
      totalInclTax: 108.25,
    })
    expect(list).toHaveBeenCalledTimes(1)
    expect(list.mock.calls[0][0]).toEqual({ kind: 'api', resource: 'salesInvoices' })
    expect(list.mock.calls[0][1]?.filter).toBe("orderNumber eq 'W-100501'")
  })

  it('falls back to external document number + customer, with quotes doubled', async () => {
    const { deps, list } = makeDeps({
      list: (_s, o) => (o?.filter?.startsWith('orderNumber') ? [] : [rec({ ...INVOICE, totalTaxAmount: '8.25', dueDate: undefined })]),
    })
    const inv = await findPostedInvoice(deps, q)
    expect(list).toHaveBeenCalledTimes(2)
    expect(list.mock.calls[1][1]?.filter).toBe(
      "externalDocumentNumber eq 'PO-9''x' and customerNumber eq 'C1'",
    )
    expect(inv?.totalTax).toBe(8.25)
    expect(inv?.dueDate).toBeNull()
  })

  it('skips the fallback when the external document number is blank', async () => {
    const { deps, list } = makeDeps({ list: () => [] })
    expect(await findPostedInvoice(deps, { ...q, externalDocumentNumber: '  ' })).toBeNull()
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('fallback ignores invoices of a different order', async () => {
    const { deps } = makeDeps({
      list: (_s, o) => (o?.filter?.startsWith('orderNumber') ? [] : [rec({ ...INVOICE, orderNumber: 'W-OTHER' })]),
    })
    expect(await findPostedInvoice(deps, q)).toBeNull()
  })

  it('fallback accepts an invoice with a blank order number', async () => {
    const { deps } = makeDeps({
      list: (_s, o) => (o?.filter?.startsWith('orderNumber') ? [] : [rec({ ...INVOICE, orderNumber: '' })]),
    })
    expect((await findPostedInvoice(deps, q))?.number).toBe('PSI-100')
  })

  it('returns null when neither matches', async () => {
    const { deps } = makeDeps()
    expect(await findPostedInvoice(deps, q)).toBeNull()
  })
})

describe('setInvoiceDates', () => {
  it('PATCHes both dates using the etag from a fresh GET', async () => {
    const { deps, get, patch } = makeDeps()
    await setInvoiceDates(deps, 'W-100501', '2026-11-15')
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ service: 'SalesOrder' }), {
      values: { Document_Type: 'Order', No: 'W-100501' },
    })
    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({ service: 'SalesOrder' }),
      { values: { Document_Type: 'Order', No: 'W-100501' } },
      'W/"fresh"',
      { Document_Date: '2026-11-15', Posting_Date: '2026-11-15' },
    )
  })
})

describe('postShipAndInvoice', () => {
  it('invokes shipAndInvoice with the id looked up by number', async () => {
    const { deps, list, invokeAction } = makeDeps({ list: () => [rec({ id: 'so-guid' })] })
    await postShipAndInvoice(deps, 'W-100501')
    expect(list.mock.calls[0][0]).toEqual({ kind: 'api', resource: 'salesOrders' })
    expect(list.mock.calls[0][1]?.filter).toBe("number eq 'W-100501'")
    expect(invokeAction).toHaveBeenCalledWith('/salesOrders(so-guid)/Microsoft.NAV.shipAndInvoice')
  })

  it('throws when the order is not found', async () => {
    const { deps, invokeAction } = makeDeps()
    await expect(postShipAndInvoice(deps, 'W-1')).rejects.toThrow(/W-1/)
    expect(invokeAction).not.toHaveBeenCalled()
  })

  const apiError = (status: number, message: string) =>
    new BcApiError({ status, statusText: 'x', message, url: 'u' })
  const failWith = (err: Error) =>
    makeDeps({ list: () => [rec({ id: 'so-guid' })], invokeAction: async () => { throw err } })

  it('a BC 400 becomes BcPostRefusedError with BC\'s message', async () => {
    const { deps } = failWith(apiError(400, 'Posting Date is not within your range of allowed posting dates.'))
    const p = postShipAndInvoice(deps, 'W-100501')
    await expect(p).rejects.toBeInstanceOf(BcPostRefusedError)
    await expect(p).rejects.toThrow('Posting Date is not within your range of allowed posting dates.')
  })

  it('a 503 becomes BcPostOutcomeUnknownError', async () => {
    const { deps } = failWith(apiError(503, 'unavailable'))
    await expect(postShipAndInvoice(deps, 'W-100501')).rejects.toBeInstanceOf(BcPostOutcomeUnknownError)
  })

  it('a timeout/network failure (status 0) becomes BcPostOutcomeUnknownError', async () => {
    const { deps } = failWith(apiError(0, 'Business Central request failed before receiving a response (aborted)'))
    await expect(postShipAndInvoice(deps, 'W-100501')).rejects.toBeInstanceOf(BcPostOutcomeUnknownError)
  })

})
