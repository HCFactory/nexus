import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, type FakeSupabase, type Row } from '@/test/fakeSupabase'
import { BcApiError } from '@/lib/businessCentral/client'
import type { BcRecord, ReferenceSource, ReferenceTransport } from '@/lib/businessCentral/customerReferences/transport'
import type { BillcomClient } from '@/lib/billcom/client'
import { BillcomApiError } from '@/lib/billcom/errors'
import { LINE_SNAPSHOT_FIELDS, snapshotOf } from './bcOrderMapping'
import { LEASE_MS } from './orderClaim'
import { NOT_IN_SYNC, retryInvoiceProcess, runInvoiceProcess, startInvoiceProcess, type InvoiceDeps } from './invoiceProcess'

const T0 = '2026-11-15T15:00:00.000Z'
const NOT_CONFIRMED = "BC didn't confirm the posting. Retry checks BC first, so it won't post twice."
const MISMATCH = "Bill.com total $108.25 doesn't match BC's posted total $110.00."
const NEEDS_ATTENTION = 'Add a name and email to this customer in Customers before invoicing.'
const BILLCOM_OFF = 'Bill.com is turned off. Turn it on in Settings before invoicing.'
const NOT_IN_BILLCOM = "This customer isn't in Bill.com yet. Push it from Customers first."

const INVOICE = {
  id: 'inv-guid',
  number: 'PSI-100',
  orderNumber: 'W-100501',
  externalDocumentNumber: 'W-100501 / PO-9',
  invoiceDate: '2026-11-15',
  dueDate: '2026-12-15',
  totalAmountExcludingTax: 100,
  totalTaxAmount: 8.25,
  totalAmountIncludingTax: 108.25,
}

const bcLine = (fields: Record<string, unknown> = {}): BcRecord => ({
  key: { values: { Document_Type: 'Order', Document_No: 'W-100501', Line_No: '10000' } },
  etag: 'W/"l1"',
  fields: { Line_No: 10000, Type: 'Item', No: 'ITEM-1', Quantity: 2, Unit_of_Measure_Code: 'EA', Unit_Price: 50, Line_Discount_Percent: 0, Location_Code: 'MAIN', ...fields },
})

const orderRow = (extra: Row = {}): Row => ({
  id: 'o1',
  organization_id: 'org-1',
  bc_connection_id: 'conn-1',
  status: 'final',
  sync_state: 'synced',
  sync_error: null,
  invoice_state: 'none',
  invoice_error: null,
  bc_order_number: 'W-100501',
  customer_number: 'C1',
  customer_po: 'PO-9',
  invoice_number: null,
  bc_snapshot: null,
  claimed_until: null,
  bc_posted_invoice_id: null,
  bc_posted_invoice_number: null,
  posted_at: null,
  invoice_date: null,
  invoice_due_date: null,
  posted_total_excl_tax: null,
  posted_total_tax: null,
  posted_total_incl_tax: null,
  billcom_invoice_id: null,
  billcom_invoiced_at: null,
  invoice_started_by: null,
  updated_at: '2026-11-01T00:00:00.000Z',
  ...extra,
})

const lineRows = (): Row[] => [
  {
    id: 'l1', organization_id: 'org-1', bc_connection_id: 'conn-1', sales_order_id: 'o1', position: 1,
    item_number: 'ITEM-1', description: 'Widget', quantity: 2, unit_price: null, discount_percent: null,
    bc_unit_price: 50, bc_line_discount_percent: 0, removed: false, bc_line_no: 10000, bc_etag: 'W/"l1"',
    bc_snapshot: snapshotOf(bcLine(), LINE_SNAPSHOT_FIELDS),
  },
  {
    id: 'l2', organization_id: 'org-1', bc_connection_id: 'conn-1', sales_order_id: 'o1', position: 2,
    item_number: 'GONE', description: 'Removed', quantity: 5, unit_price: 99, discount_percent: null,
    bc_unit_price: null, bc_line_discount_percent: null, removed: true, bc_line_no: null, bc_etag: null, bc_snapshot: null,
  },
]

const linkRow = (extra: Row = {}): Row => ({
  id: 'link-1',
  organization_id: 'org-1',
  bc_connection_id: 'conn-1',
  billcom_connection_id: 'bcom-1',
  bc_customer_number: 'C1',
  status: 'synced',
  billcom_customer_id: 'BCUST-1',
  ...extra,
})

/** Fake BC: the order header + lines, posted invoices, and the post action. */
function fakeBc() {
  const state = {
    lines: [bcLine()],
    posted: [] as Record<string, unknown>[],
    /** What the post does; default: BC posts INVOICE. */
    onPost: async () => { state.posted.push({ ...INVOICE }) },
  }
  const header = (): BcRecord => ({ key: { values: { Document_Type: 'Order', No: 'W-100501' } }, etag: 'W/"h1"', fields: { No: 'W-100501' } })
  const list = vi.fn(async (s: ReferenceSource, o: { filter?: string } = {}) => {
    if (s.kind === 'api' && s.resource === 'salesInvoices') {
      const f = o.filter ?? ''
      return state.posted
        .filter((inv) => (f.startsWith('orderNumber') ? f === `orderNumber eq '${inv.orderNumber}'` : f.includes(`'${inv.externalDocumentNumber}'`)))
        .map((fields) => ({ key: { bcId: String(fields.id) }, etag: 'x', fields }))
    }
    if (s.kind === 'api' && s.resource === 'salesOrders') return [{ key: { bcId: 'so-guid' }, etag: 'x', fields: { id: 'so-guid', number: 'W-100501' } }]
    if (s.kind === 'odata' && s.service === 'SalesOrderSalesLines') return state.lines
    throw new Error(`unexpected list ${JSON.stringify(s)}`)
  })
  const get = vi.fn(async () => header())
  const patch = vi.fn<(s: ReferenceSource, k: unknown, e: string, f: Record<string, unknown>) => Promise<BcRecord>>(async () => header())
  const transport = { list, get, patch, create: vi.fn(), remove: vi.fn() } as unknown as ReferenceTransport
  const invokeAction = vi.fn<(path: string) => Promise<void>>(async () => state.onPost())
  return { state, list, get, patch, transport, invokeAction }
}

/** Fake Bill.com: GET /v3/invoices lists, POST /v3/invoices creates. */
function fakeBillcom() {
  const state = {
    invoices: [] as { id: string; invoiceNumber: string; customerId: string }[],
    fail: null as null | ((method: string) => Error | null),
  }
  const posts: Record<string, unknown>[] = []
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const err = state.fail?.(method)
    if (err) throw err
    if (method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      posts.push(body)
      const id = `BINV-${posts.length}`
      state.invoices.push({ id, invoiceNumber: String(body.invoiceNumber), customerId: String((body.customer as { id: string }).id) })
      return { id }
    }
    const customerId = /customerId%3Aeq%3A([^&]+)/.exec(path)?.[1]
    return { results: state.invoices.filter((i) => i.customerId === customerId) }
  })
  const client = { request, login: vi.fn(), getSession: vi.fn() } as unknown as BillcomClient
  return { state, posts, request, client }
}

let db: FakeSupabase
let bc: ReturnType<typeof fakeBc>
let bill: ReturnType<typeof fakeBillcom>

function makeDeps(extra: Partial<InvoiceDeps> = {}): InvoiceDeps {
  return {
    supabase: db.client,
    transport: bc.transport,
    orgId: 'org-1',
    connectionId: 'conn-1',
    now: () => T0,
    invokeAction: bc.invokeAction,
    billcom: bill.client,
    billcomConnectionId: 'bcom-1',
    timeZone: 'America/Chicago',
    userId: 'user-1',
    ...extra,
  }
}

const order = () => db.tables.sales_orders[0]

function setup(o: Row = {}, link: Row | null = {}) {
  db = fakeSupabase({
    sales_orders: [orderRow(o)],
    sales_order_lines: lineRows(),
    billcom_customer_links: link ? [linkRow(link)] : [],
  })
  bc = fakeBc()
  bill = fakeBillcom()
}

/** The never-twice guarantees, checked after every scenario. */
function expectAtMostOnce() {
  expect(bc.invokeAction.mock.calls.length).toBeLessThanOrEqual(1)
  expect(bill.posts.length).toBeLessThanOrEqual(1)
}

beforeEach(() => {
  vi.restoreAllMocks()
  setup()
})

describe('startInvoiceProcess', () => {
  it('sets posting and who started it, without running any step', async () => {
    expect(await startInvoiceProcess(makeDeps(), 'o1')).toEqual({ ok: true })
    expect(order()).toMatchObject({ invoice_state: 'posting', invoice_error: null, invoice_started_by: 'user-1', updated_at: T0, claimed_until: null })
    expect(bc.list).not.toHaveBeenCalled()
    expect(bc.invokeAction).not.toHaveBeenCalled()
  })

  it('refuses a second start while posting', async () => {
    await startInvoiceProcess(makeDeps(), 'o1')
    expect(await startInvoiceProcess(makeDeps(), 'o1')).toEqual({ ok: false, error: "This order can't be invoiced right now." })
  })

  it('refuses while the lease is held', async () => {
    setup({ claimed_until: new Date(Date.parse(T0) + 5000).toISOString() })
    expect(await startInvoiceProcess(makeDeps(), 'o1')).toEqual({ ok: false, error: 'This order is busy. Try again in a moment.' })
    expect(order().invoice_state).toBe('none')
  })

  it('refuses an unknown order', async () => {
    expect(await startInvoiceProcess(makeDeps(), 'nope')).toEqual({ ok: false, error: 'Sales order not found.' })
  })

  it('refuses when Bill.com is off', async () => {
    expect(await startInvoiceProcess(makeDeps({ billcom: null }), 'o1')).toEqual({ ok: false, error: BILLCOM_OFF })
    expect(order().invoice_state).toBe('none')
  })

  it('refuses when the customer has no ready link', async () => {
    setup({}, null)
    expect(await startInvoiceProcess(makeDeps(), 'o1')).toEqual({ ok: false, error: NOT_IN_BILLCOM })
    setup({}, { status: 'needs_attention' })
    expect(await startInvoiceProcess(makeDeps(), 'o1')).toEqual({ ok: false, error: NEEDS_ATTENTION })
    expect(order().invoice_state).toBe('none')
  })
})

describe('runInvoiceProcess', () => {
  it('happy path: none -> done, dates set, posted once, Bill.com invoice created once', async () => {
    await startInvoiceProcess(makeDeps(), 'o1')
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBe('done')

    expect(bc.patch).toHaveBeenCalledTimes(1)
    expect(bc.patch.mock.calls[0][3]).toEqual({ Document_Date: '2026-11-15', Posting_Date: '2026-11-15' })
    expect(bc.invokeAction).toHaveBeenCalledTimes(1)
    expect(bc.invokeAction).toHaveBeenCalledWith('/salesOrders(so-guid)/Microsoft.NAV.shipAndInvoice')
    expect(bill.posts).toHaveLength(1)
    expect(bill.posts[0]).toEqual({
      customer: { id: 'BCUST-1' },
      invoiceNumber: 'W-100501 / PO-9',
      invoiceDate: '2026-11-15',
      dueDate: '2026-12-15',
      processingOptions: { sendEmail: false },
      invoiceLineItems: [
        { description: 'ITEM-1 Widget', quantity: 2, price: 50 },
        { description: 'Sales tax', quantity: 1, price: 8.25 },
      ],
    })
    expect(order()).toMatchObject({
      invoice_state: 'done',
      status: 'invoiced',
      invoice_error: null,
      bc_posted_invoice_id: 'inv-guid',
      bc_posted_invoice_number: 'PSI-100',
      posted_at: T0,
      invoice_date: '2026-11-15',
      invoice_due_date: '2026-12-15',
      posted_total_excl_tax: 100,
      posted_total_tax: 8.25,
      posted_total_incl_tax: 108.25,
      billcom_invoice_id: 'BINV-1',
      billcom_invoiced_at: T0,
      claimed_until: null,
    })
    // `posted` and `invoiced` land in one update.
    const postedWrite = db.writes.find(([t, op, p]) => t === 'sales_orders' && op === 'update' && (p as Row).invoice_state === 'posted')
    expect(postedWrite?.[2]).toMatchObject({ status: 'invoiced', bc_posted_invoice_number: 'PSI-100', posted_total_incl_tax: 108.25 })
    expectAtMostOnce()
  })

  it('skips posting when BC already holds the posted invoice', async () => {
    setup({ invoice_state: 'posting' })
    bc.state.posted.push({ ...INVOICE })
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBe('done')
    expect(bc.invokeAction).not.toHaveBeenCalled()
    expect(bc.patch).not.toHaveBeenCalled()
    expect(order()).toMatchObject({ status: 'invoiced', bc_posted_invoice_number: 'PSI-100' })
    expectAtMostOnce()
  })

  it('finds a crash-recovered invoice by Invoice # when BC lost the order number link', async () => {
    setup({ invoice_state: 'posting' })
    bc.state.posted.push({ ...INVOICE, orderNumber: '' })
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBe('done')
    expect(bc.invokeAction).not.toHaveBeenCalled()
    expectAtMostOnce()
  })

  it('BC conflict: back to none, Changed in BC, nothing posted', async () => {
    setup({ invoice_state: 'posting' })
    bc.state.lines = [bcLine({ Quantity: 3 })]
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBe('none')
    expect(order()).toMatchObject({ invoice_state: 'none', sync_state: 'conflict', sync_error: 'Changed in BC', status: 'final' })
    expect(bc.patch).not.toHaveBeenCalled()
    expect(bc.invokeAction).not.toHaveBeenCalled()
    expect(bill.request).not.toHaveBeenCalled()
  })

  it('post refused: post_failed with BC message, status unchanged', async () => {
    setup({ invoice_state: 'posting' })
    bc.state.onPost = async () => { throw new BcApiError({ status: 400, statusText: 'Bad Request', message: 'Item ITEM-1 is blocked.', url: 'u' }) }
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBe('post_failed')
    expect(order()).toMatchObject({ invoice_state: 'post_failed', invoice_error: 'Item ITEM-1 is blocked.', status: 'final' })
    expect(bill.request).not.toHaveBeenCalled()
    expect(bc.invokeAction).toHaveBeenCalledTimes(1)
    expectAtMostOnce()
  })

  it('post outcome unknown but BC posted: records it and finishes', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    setup({ invoice_state: 'posting' })
    bc.state.onPost = async () => {
      bc.state.posted.push({ ...INVOICE })
      throw new BcApiError({ status: 504, statusText: 'Gateway Timeout', message: 'timeout', url: 'u' })
    }
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBe('done')
    expect(order()).toMatchObject({ status: 'invoiced', bc_posted_invoice_id: 'inv-guid' })
    expect(logged).toHaveBeenCalledTimes(1)
    expectAtMostOnce()
  })

  it('post outcome unknown and nothing posted: post_failed with the not-confirmed message', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    setup({ invoice_state: 'posting' })
    bc.state.onPost = async () => { throw new BcApiError({ status: 503, statusText: 'Unavailable', message: 'down', url: 'u' }) }
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBe('post_failed')
    expect(order()).toMatchObject({ invoice_state: 'post_failed', invoice_error: NOT_CONFIRMED, status: 'final' })
    expect(logged).toHaveBeenCalledTimes(1)
    expectAtMostOnce()
  })

  it('a network error on the post is treated as unknown', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    setup({ invoice_state: 'posting' })
    bc.state.onPost = async () => { throw new TypeError('fetch failed') }
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBe('post_failed')
    expect(order().invoice_error).toBe(NOT_CONFIRMED)
    expect(logged).toHaveBeenCalledTimes(1)
    expectAtMostOnce()
  })

  it('post succeeded but the invoice is not readable yet: post_failed, not-confirmed', async () => {
    setup({ invoice_state: 'posting' })
    bc.state.onPost = async () => undefined
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBe('post_failed')
    expect(order()).toMatchObject({ invoice_error: NOT_CONFIRMED, status: 'final' })
    expectAtMostOnce()
  })

  it('an error before posting: post_failed with that error, nothing posted', async () => {
    setup({ invoice_state: 'posting' })
    bc.get.mockRejectedValueOnce(new Error('BC is down'))
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBe('post_failed')
    expect(order()).toMatchObject({ invoice_state: 'post_failed', invoice_error: 'BC is down' })
    expect(bc.invokeAction).not.toHaveBeenCalled()
  })

  it('Bill.com down: billcom_failed, status invoiced', async () => {
    setup({ invoice_state: 'posting' })
    bill.state.fail = () => new BillcomApiError({ status: 503, statusText: 'Unavailable', message: 'Bill.com is unavailable', url: 'u' })
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBe('billcom_failed')
    expect(order()).toMatchObject({ invoice_state: 'billcom_failed', status: 'invoiced', invoice_error: 'Bill.com is unavailable', bc_posted_invoice_number: 'PSI-100' })
    expectAtMostOnce()
  })

  it('Bill.com off after posting: billcom_failed with the off text', async () => {
    setup({ invoice_state: 'posting' })
    expect(await runInvoiceProcess(makeDeps({ billcom: null }), 'o1')).toBe('billcom_failed')
    expect(order()).toMatchObject({ status: 'invoiced', invoice_error: BILLCOM_OFF })
  })

  it('Bill.com invoice already exists: done without create', async () => {
    setup({ invoice_state: 'posting' })
    bill.state.invoices.push({ id: 'BINV-OLD', invoiceNumber: 'W-100501 / PO-9', customerId: 'BCUST-1' })
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBe('done')
    expect(bill.posts).toHaveLength(0)
    expect(order().billcom_invoice_id).toBe('BINV-OLD')
  })

  it('link now needs_attention: billcom_failed with the exact message, no Bill.com call', async () => {
    setup({ invoice_state: 'posting' }, { status: 'needs_attention' })
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBe('billcom_failed')
    expect(order()).toMatchObject({ invoice_state: 'billcom_failed', invoice_error: NEEDS_ATTENTION, status: 'invoiced' })
    expect(bill.request).not.toHaveBeenCalled()
  })

  it('totals mismatch: billcom_failed with the mismatch message, nothing created', async () => {
    setup({ invoice_state: 'posting' })
    bc.state.onPost = async () => { bc.state.posted.push({ ...INVOICE, totalAmountIncludingTax: 110 }) }
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBe('billcom_failed')
    expect(order()).toMatchObject({ invoice_error: MISMATCH, status: 'invoiced', posted_total_incl_tax: 110 })
    expect(bill.posts).toHaveLength(0)
  })

  it('duplicate invoice number from Bill.com: looks it up and finishes', async () => {
    setup({ invoice_state: 'billcom_sending', status: 'invoiced', ...postedColumns() })
    bill.state.fail = (method) => {
      if (method !== 'POST') return null
      bill.state.invoices.push({ id: 'BINV-RACE', invoiceNumber: 'W-100501 / PO-9', customerId: 'BCUST-1' })
      return new BillcomApiError({ status: 422, statusText: 'Unprocessable', code: 'BDC_1171', message: 'Duplicate invoice number', url: 'u' })
    }
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBe('done')
    expect(order().billcom_invoice_id).toBe('BINV-RACE')
    expect(bill.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(bc.invokeAction).not.toHaveBeenCalled()
  })

  it('duplicate invoice number but not found: billcom_failed', async () => {
    setup({ invoice_state: 'billcom_sending', status: 'invoiced', ...postedColumns() })
    bill.state.fail = (method) =>
      method === 'POST' ? new BillcomApiError({ status: 422, statusText: 'x', code: 'BDC_1171', message: 'Duplicate invoice number', url: 'u' }) : null
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBe('billcom_failed')
    expect(bill.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('lease held: returns null and changes nothing', async () => {
    const held = new Date(Date.parse(T0) + LEASE_MS / 2).toISOString()
    setup({ invoice_state: 'posting', claimed_until: held })
    const before = { ...order() }
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBeNull()
    expect(order()).toEqual(before)
    expect(bc.list).not.toHaveBeenCalled()
    expect(bc.invokeAction).not.toHaveBeenCalled()
  })

  it.each(['none', 'done', 'post_failed', 'billcom_failed'] as const)('does nothing in %s', async (state) => {
    setup({ invoice_state: state })
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBe(state)
    expect(order().invoice_state).toBe(state)
    expect(bc.list).not.toHaveBeenCalled()
    expect(bill.request).not.toHaveBeenCalled()
  })

  it('throws a clear error when a state write fails', async () => {
    setup({ invoice_state: 'posting' })
    db.failOn = (table, op, p) => (table === 'sales_orders' && op === 'update' && (p as Row).invoice_state === 'posted' ? 'db down' : null)
    await expect(runInvoiceProcess(makeDeps(), 'o1')).rejects.toThrow('Could not save the invoice state: db down')
    expect(bc.invokeAction).toHaveBeenCalledTimes(1)
  })
})

describe('lease and ownership', () => {
  it('holds the lease past BC\'s post timeout during the post, and releases it after', async () => {
    setup({ invoice_state: 'posting' })
    let during: string | null = null
    bc.state.onPost = async () => {
      during = order().claimed_until as string
      bc.state.posted.push({ ...INVOICE })
    }
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBe('done')
    expect(Date.parse(during!)).toBeGreaterThanOrEqual(Date.parse(T0) + 180_000)
    expect(order().claimed_until).toBeNull()
  })

  it('a renewal that matches no row (lease taken) stops before posting, without writing', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    setup({ invoice_state: 'posting' })
    const other = new Date(Date.parse(T0) + 999_000).toISOString()
    // Another runner claims the order while we set the dates.
    bc.patch.mockImplementationOnce(async () => {
      order().claimed_until = other
      return { key: { values: {} }, etag: 'x', fields: {} }
    })
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBeNull()
    expect(bc.invokeAction).not.toHaveBeenCalled()
    expect(order()).toMatchObject({ invoice_state: 'posting', invoice_error: null, claimed_until: other })
    expect(db.writes.filter(([t, op, p]) => t === 'sales_orders' && op === 'update' && 'invoice_state' in (p as Row))).toHaveLength(0)
    expect(warned).toHaveBeenCalledTimes(1)
  })

  it('a renewal at a later step that matches no row stops before Bill.com', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    setup({ invoice_state: 'posting' })
    db.failOn = (table, op, p) => {
      // After `posted` is saved, someone else takes the lease.
      if (table === 'sales_orders' && op === 'update' && (p as Row).invoice_state === 'posted') {
        order().claimed_until = '2099-01-01T00:00:00.000Z'
      }
      return null
    }
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBeNull()
    expect(order().invoice_state).toBe('posted')
    expect(bill.request).not.toHaveBeenCalled()
    expect(warned).toHaveBeenCalledTimes(1)
  })

  it('a compare-and-set miss on the posted write stops without further writes', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    setup({ invoice_state: 'posting' })
    bc.state.onPost = async () => {
      bc.state.posted.push({ ...INVOICE })
      // Another runner finished the order meanwhile.
      Object.assign(order(), { invoice_state: 'done', billcom_invoice_id: 'BINV-OTHER' })
    }
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBeNull()
    expect(order()).toMatchObject({ invoice_state: 'done', billcom_invoice_id: 'BINV-OTHER', invoice_error: null })
    const stateWrites = db.writes.filter(([t, op, p]) => t === 'sales_orders' && op === 'update' && 'invoice_state' in (p as Row))
    expect(stateWrites.map(([, , p]) => (p as Row).invoice_state)).toEqual(['posted'])
    expect(bill.request).not.toHaveBeenCalled()
    expect(warned).toHaveBeenCalledTimes(1)
    expectAtMostOnce()
  })

  it('a late post_failed never overwrites a newer state', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    setup({ invoice_state: 'posting' })
    bc.state.onPost = async () => {
      Object.assign(order(), { invoice_state: 'posted' })
      throw new BcApiError({ status: 400, statusText: 'Bad Request', message: 'refused', url: 'u' })
    }
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBeNull()
    expect(order()).toMatchObject({ invoice_state: 'posted', invoice_error: null })
  })
})

describe('posting needs an order that is In BC', () => {
  it.each([
    [{ sync_state: 'pending' }],
    [{ sync_state: 'failed' }],
    [{ status: 'draft' }],
  ])('posting with %o: post_failed with the save message, nothing posted', async (extra) => {
    setup({ invoice_state: 'posting', ...extra })
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBe('post_failed')
    expect(order()).toMatchObject({ invoice_state: 'post_failed', invoice_error: NOT_IN_SYNC })
    expect(bc.patch).not.toHaveBeenCalled()
    expect(bc.invokeAction).not.toHaveBeenCalled()
  })

  it('still records an already-posted invoice first, even when the order is not in sync', async () => {
    setup({ invoice_state: 'posting', sync_state: 'pending' })
    bc.state.posted.push({ ...INVOICE })
    expect(await runInvoiceProcess(makeDeps(), 'o1')).toBe('done')
    expect(bc.invokeAction).not.toHaveBeenCalled()
  })
})

function postedColumns(): Row {
  return {
    bc_posted_invoice_id: 'inv-guid',
    bc_posted_invoice_number: 'PSI-100',
    posted_at: T0,
    invoice_date: '2026-11-15',
    invoice_due_date: '2026-12-15',
    posted_total_excl_tax: 100,
    posted_total_tax: 8.25,
    posted_total_incl_tax: 108.25,
  }
}

describe('retryInvoiceProcess', () => {
  it('post_failed -> posting: checks BC first, then posts, and finishes', async () => {
    setup({ invoice_state: 'post_failed', invoice_error: 'Item ITEM-1 is blocked.' })
    expect(await retryInvoiceProcess(makeDeps(), 'o1')).toEqual({ ok: true, state: 'done' })
    expect(bc.invokeAction).toHaveBeenCalledTimes(1)
    expect(order()).toMatchObject({ invoice_state: 'done', invoice_error: null, status: 'invoiced' })
    expectAtMostOnce()
  })

  it('post_failed after an unconfirmed post that did land: never posts again', async () => {
    setup({ invoice_state: 'post_failed', invoice_error: NOT_CONFIRMED })
    bc.state.posted.push({ ...INVOICE })
    expect(await retryInvoiceProcess(makeDeps(), 'o1')).toEqual({ ok: true, state: 'done' })
    expect(bc.invokeAction).not.toHaveBeenCalled()
  })

  it('billcom_failed -> billcom_sending: no BC calls, creates the Bill.com invoice', async () => {
    setup({ invoice_state: 'billcom_failed', invoice_error: 'Bill.com is unavailable', status: 'invoiced', ...postedColumns() })
    expect(await retryInvoiceProcess(makeDeps(), 'o1')).toEqual({ ok: true, state: 'done' })
    expect(bc.list).not.toHaveBeenCalled()
    expect(bc.invokeAction).not.toHaveBeenCalled()
    expect(bill.posts).toHaveLength(1)
    expect(order()).toMatchObject({ invoice_state: 'done', invoice_error: null, billcom_invoice_id: 'BINV-1' })
  })

  it('billcom_failed with the link still not ready stays billcom_failed', async () => {
    setup({ invoice_state: 'billcom_failed', status: 'invoiced', ...postedColumns() }, { status: 'failed' })
    expect(await retryInvoiceProcess(makeDeps(), 'o1')).toEqual({ ok: true, state: 'billcom_failed' })
    expect(order().invoice_error).toBe("This customer couldn't be sent to Bill.com. Retry it from Customers first.")
    expect(bill.request).not.toHaveBeenCalled()
  })

  it.each([
    [{ status: 'draft' }],
    [{ sync_state: 'pending' }],
    [{ sync_state: 'failed' }],
  ])('post_failed with %o: refuses up front with the save message', async (extra) => {
    setup({ invoice_state: 'post_failed', invoice_error: 'Item ITEM-1 is blocked.', ...extra })
    expect(await retryInvoiceProcess(makeDeps(), 'o1')).toEqual({ ok: false, error: NOT_IN_SYNC })
    expect(order()).toMatchObject({ invoice_state: 'post_failed', invoice_error: 'Item ITEM-1 is blocked.' })
    expect(bc.list).not.toHaveBeenCalled()
  })

  it('billcom_failed retries even though the order is no longer Final (it is Invoiced)', async () => {
    setup({ invoice_state: 'billcom_failed', status: 'invoiced', ...postedColumns() })
    expect(await retryInvoiceProcess(makeDeps(), 'o1')).toEqual({ ok: true, state: 'done' })
  })

  it.each(['none', 'posting', 'done'] as const)('refuses in %s', async (state) => {
    setup({ invoice_state: state })
    expect(await retryInvoiceProcess(makeDeps(), 'o1')).toEqual({ ok: false, error: 'Nothing to retry.' })
    expect(bc.list).not.toHaveBeenCalled()
  })

  it('refuses while the lease is held', async () => {
    setup({ invoice_state: 'post_failed', claimed_until: new Date(Date.parse(T0) + 5000).toISOString() })
    expect(await retryInvoiceProcess(makeDeps(), 'o1')).toEqual({ ok: false, error: 'This order is busy. Try again in a moment.' })
    expect(order().invoice_state).toBe('post_failed')
  })
})
