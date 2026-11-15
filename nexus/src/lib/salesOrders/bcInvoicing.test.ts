import { describe, expect, it, vi } from 'vitest'
import type { BcRecord, ReferenceSource, ReferenceTransport } from '@/lib/businessCentral/customerReferences/transport'
import { findPostedInvoice, postShipAndInvoice, setInvoiceDates, type BcInvoicingDeps } from './bcInvoicing'

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
    expect(inv).toEqual({
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

  it('propagates BC errors', async () => {
    const { deps } = makeDeps({
      list: () => [rec({ id: 'so-guid' })],
      invokeAction: async () => {
        throw new Error('Posting Date is not within your range of allowed posting dates.')
      },
    })
    await expect(postShipAndInvoice(deps, 'W-100501')).rejects.toThrow(/allowed posting dates/)
  })
})
