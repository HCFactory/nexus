import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fakeSupabase, type FakeSupabase, type Row } from '@/test/fakeSupabase'
import type { BillcomClient } from '@/lib/billcom/client'
import type { ChangeLine } from '@/types/invoiceChanges'
import { BcPostOutcomeUnknownError, BcPostRefusedError } from './bcInvoicing'
import type { BcInvoiceState } from './bcInvoiceChange'
import type { InvoiceDeps } from './invoiceProcess'

vi.mock('./bcInvoiceChange', () => ({
  CANCELED: 'Canceled',
  readBcInvoice: vi.fn(),
  cancelBcInvoice: vi.fn(),
  findDraftInvoice: vi.fn(),
  createDraftInvoice: vi.fn(),
  applyDraftHeader: vi.fn(),
  setDraftLines: vi.fn(),
  checkDraft: vi.fn(),
  postDraftInvoice: vi.fn(),
  listChangeDrafts: vi.fn(),
  deleteDraftInvoice: vi.fn(),
}))
vi.mock('@/lib/billcom/invoicePush', async (orig) => ({
  ...(await orig<typeof import('@/lib/billcom/invoicePush')>()),
  findBillcomInvoice: vi.fn(),
  replaceBillcomInvoice: vi.fn(),
  findOrCreateBillcomInvoice: vi.fn(),
}))

import * as bc from './bcInvoiceChange'
import * as push from '@/lib/billcom/invoicePush'
import {
  deleteExtraDrafts,
  discardInvoiceChange,
  findExtraDrafts,
  loadOpenChange,
  retryInvoiceChange,
  runInvoiceChange,
  startInvoiceChange,
  sweepInvoiceChanges,
} from './invoiceChangeProcess'

const T0 = '2026-11-17T10:00:00.000Z'
const OLD = '143fbb46-e8e0-f111-84e4-7ced8d88ddac'
const NEW = '7aa0c3d1-0000-4000-8000-000000000415'
const CHANGES = 'sales_invoice_changes'

const old = (over: Partial<BcInvoiceState> = {}): BcInvoiceState => ({
  id: OLD, number: 'INV-100411', status: 'Open', externalDocumentNumber: 'W-100528', customerNumber: 'W00389',
  invoiceDate: '2026-11-15', dueDate: '2026-12-15', totalExclTax: 24.5, totalTax: 0.12, totalInclTax: 24.62,
  raw: { id: OLD, status: 'Open' }, ...over,
})
const neu = (over: Partial<BcInvoiceState> = {}): BcInvoiceState => ({
  ...old(), id: NEW, number: 'INV-100415', totalExclTax: 49, totalTax: 0.24, totalInclTax: 49.24, raw: { id: NEW, status: 'Open' }, ...over,
})

const after: ChangeLine[] = [{ item_number: '20000', description: 'Candy', unit_of_measure_code: 'BOX', quantity: 2, unit_price: 24.5, discount_percent: 0 }]

const orderRow = (extra: Row = {}): Row => ({
  id: 'o1', organization_id: 'org-1', bc_connection_id: 'conn-1', status: 'invoiced', sync_state: 'synced',
  invoice_state: 'done', invoice_error: null, bc_order_number: 'W-100528', customer_number: 'W00389', customer_po: '',
  invoice_number: null, claimed_until: null, bc_posted_invoice_id: OLD, bc_posted_invoice_number: 'INV-100411',
  posted_total_excl_tax: 24.5, posted_total_tax: 0.12, posted_total_incl_tax: 24.62, total_incl_tax: 24.62,
  billcom_invoice_id: '00eX', updated_at: '2026-11-15T00:00:00.000Z', ...extra,
})
const lineRow = (): Row => ({
  id: 'l1', organization_id: 'org-1', bc_connection_id: 'conn-1', sales_order_id: 'o1', position: 1,
  item_number: '20000', description: 'Candy', unit_of_measure_code: 'BOX', quantity: 1, unit_price: 24.5, discount_percent: 0,
  bc_unit_price: 24.5, bc_line_discount_percent: null, removed: false, bc_line_no: 10000, bc_etag: null, amount_incl_tax: 24.62, bc_snapshot: null,
})
const link = (): Row => ({
  id: 'k', organization_id: 'org-1', bc_connection_id: 'conn-1', billcom_connection_id: 'bcom-1', bc_customer_number: 'W00389',
  status: 'synced', billcom_customer_id: '0cu1',
})
const changeRow = (extra: Row = {}): Row => ({
  id: 'ch1', organization_id: 'org-1', bc_connection_id: 'conn-1', sales_order_id: 'o1', state: 'pending', error: null,
  reason: 'why', changed_by: 'u1', changed_by_name: 'Pat', created_at: T0, updated_at: T0, finished_at: null,
  old_bc_invoice_id: OLD, old_bc_invoice_number: 'INV-100411', old_total: 24.62, cancelled_at: null, draft_bc_invoice_id: null,
  new_bc_invoice_id: null, new_bc_invoice_number: null, new_total: null,
  lines_before: [{ ...after[0], quantity: 1 }], lines_after: after, ...extra,
})

let fake: FakeSupabase
let deps: InvoiceDeps
let mirror: ReturnType<typeof vi.fn>
/** BC's view of the invoices for the fakes below. */
let bcState: { oldStatus: string; posted: Set<string> }

function setup(tables: { order?: Row; change?: Row | null; billcom?: boolean } = {}) {
  fake = fakeSupabase({
    // An open change means the order is 'changing' (unless the test says otherwise).
    sales_orders: [orderRow({ ...(tables.change ? { invoice_state: 'changing' } : {}), ...tables.order })],
    sales_order_lines: [lineRow()],
    billcom_customer_links: [link()],
    [CHANGES]: tables.change === null || tables.change === undefined ? [] : [tables.change],
  })
  mirror = vi.fn(async () => undefined)
  deps = {
    supabase: fake.client, transport: {} as never, orgId: 'org-1', connectionId: 'conn-1', now: () => T0,
    invokeAction: vi.fn(), billcom: tables.billcom === false ? null : ({} as BillcomClient),
    billcomConnectionId: tables.billcom === false ? null : 'bcom-1', timeZone: null, userId: 'u1', mirrorPostedInvoice: mirror,
  } as unknown as InvoiceDeps
}

const change = () => fake.tables[CHANGES][0]
const order = () => fake.tables.sales_orders[0]

beforeEach(() => {
  vi.clearAllMocks()
  bcState = { oldStatus: 'Open', posted: new Set() }
  // BC keeps a draft's id when it posts it: a posted draft reads back as the corrected invoice.
  vi.mocked(bc.readBcInvoice).mockImplementation(async (_d, id) =>
    id === OLD ? old({ status: bcState.oldStatus }) : id === NEW || bcState.posted.has(id) ? neu() : id.startsWith('draft') ? neu({ id, number: 'S-INV1', status: 'Draft' }) : null,
  )
  vi.mocked(bc.cancelBcInvoice).mockImplementation(async () => { bcState.oldStatus = 'Canceled' })
  vi.mocked(bc.findDraftInvoice).mockResolvedValue(null)
  vi.mocked(bc.createDraftInvoice).mockResolvedValue({ id: 'draft-1', no: 'S-INV1' })
  vi.mocked(bc.applyDraftHeader).mockResolvedValue(undefined)
  vi.mocked(bc.setDraftLines).mockResolvedValue(undefined)
  vi.mocked(bc.checkDraft).mockResolvedValue(null)
  vi.mocked(bc.listChangeDrafts).mockResolvedValue([])
  vi.mocked(bc.deleteDraftInvoice).mockResolvedValue(undefined)
  vi.mocked(bc.postDraftInvoice).mockImplementation(async (_d, draft) => { bcState.posted.add(draft.id) })
  vi.mocked(push.findBillcomInvoice).mockResolvedValue(null)
  vi.mocked(push.replaceBillcomInvoice).mockImplementation(async (_c, id) => ({ id, totalAmount: 49.24, lineCount: 2 }))
  vi.mocked(push.findOrCreateBillcomInvoice).mockResolvedValue({ id: '00eNEW', totalAmount: 49.24, lineCount: 2 })
})

const start = (extra: Partial<Parameters<typeof startInvoiceChange>[1]> = {}) =>
  startInvoiceChange(deps, { orderId: 'o1', reason: '  Customer got 2  ', lines: after, userId: 'u1', userName: 'Pat', blockedReason: null, ...extra })

describe('startInvoiceChange', () => {
  it('writes a pending change with the lines before and after, and sets the order to changing', async () => {
    setup()
    expect(await start()).toEqual({ ok: true, changeId: change().id })
    expect(change()).toMatchObject({
      state: 'pending', reason: 'Customer got 2', changed_by: 'u1', changed_by_name: 'Pat', sales_order_id: 'o1',
      organization_id: 'org-1', bc_connection_id: 'conn-1', old_bc_invoice_id: OLD, old_bc_invoice_number: 'INV-100411', old_total: 24.62,
      lines_before: [{ ...after[0], quantity: 1 }], lines_after: after,
    })
    expect(order().invoice_state).toBe('changing')
    expect(fake.tables.sales_order_lines[0].quantity).toBe(1)
  })

  it('blocked reason is returned and nothing is written', async () => {
    setup()
    expect(await start({ blockedReason: "Paid or partly paid in Bill.com — can't change" })).toEqual({ ok: false, error: "Paid or partly paid in Bill.com — can't change" })
    expect(fake.tables[CHANGES]).toHaveLength(0)
    expect(order().invoice_state).toBe('done')
  })

  it('refuses an order that is not invoiced, and an invalid change', async () => {
    setup({ order: { invoice_state: 'billcom_failed' } })
    expect(await start()).toEqual({ ok: false, error: "This invoice can't be changed right now." })
    setup()
    expect(await start({ lines: [{ ...after[0], quantity: 1 }] })).toEqual({ ok: false, error: 'Nothing changed.' })
  })

  it('second start is refused', async () => {
    setup()
    fake.failOn = (t, op) => (t === CHANGES && op === 'insert' ? 'duplicate key value violates unique constraint "sales_invoice_changes_one_open_idx"' : null)
    expect(await start()).toEqual({ ok: false, error: 'A change is already open for this invoice.' })
    expect(order().invoice_state).toBe('done')
    setup({ order: { claimed_until: '2026-11-17T10:01:00.000Z' } })
    expect(await start()).toEqual({ ok: false, error: 'This order is busy. Try again in a moment.' })
  })
})

describe('runInvoiceChange', () => {
  it('happy path: pending → done, BC cancel then post, Bill.com PUT, order points at the new invoice', async () => {
    setup({ change: changeRow() })
    expect(await runInvoiceChange(deps, 'ch1')).toBe('done')
    expect(bc.cancelBcInvoice).toHaveBeenCalledWith(deps, OLD)
    expect(bc.createDraftInvoice).toHaveBeenCalledWith(deps, expect.objectContaining({ id: 'o1' }), expect.objectContaining({ id: OLD }), 'W-100528')
    expect(bc.applyDraftHeader).toHaveBeenCalledWith(deps, { id: 'draft-1', no: 'S-INV1' }, expect.objectContaining({ id: 'o1' }), expect.objectContaining({ id: OLD }))
    expect(bc.setDraftLines).toHaveBeenCalledWith(deps, { id: 'draft-1', no: 'S-INV1' }, after)
    expect(bc.postDraftInvoice).toHaveBeenCalledTimes(1)
    const [, id, payload] = vi.mocked(push.replaceBillcomInvoice).mock.calls[0]
    expect(id).toBe('00eX')
    expect(payload).toMatchObject({
      customer: { id: '0cu1' }, invoiceNumber: 'W-100528', invoiceDate: '2026-11-15', dueDate: '2026-12-15',
      invoiceLineItems: [{ description: '20000 Candy', quantity: 2, price: 24.5 }, { description: 'Sales tax', quantity: 1, price: 0.24 }],
    })
    expect(change()).toMatchObject({
      state: 'done', error: null, cancelled_at: T0, draft_bc_invoice_id: 'draft-1', finished_at: T0,
      new_bc_invoice_id: NEW, new_bc_invoice_number: 'INV-100415', new_total: 49.24,
    })
    expect(order()).toMatchObject({
      invoice_state: 'done', bc_posted_invoice_id: NEW, bc_posted_invoice_number: 'INV-100415',
      posted_total_excl_tax: 49, posted_total_tax: 0.24, posted_total_incl_tax: 49.24, total_incl_tax: 49.24, total_excl_tax: 49, total_tax: 0.24, claimed_until: null,
    })
    expect(fake.tables.sales_order_lines).toEqual([
      expect.objectContaining({ id: 'l1', quantity: 2, unit_price: 24.5, discount_percent: 0, bc_unit_price: 24.5, bc_line_discount_percent: 0, removed: false }),
    ])
    expect(mirror).toHaveBeenCalledWith(expect.objectContaining({ id: NEW }))
  })

  it('old invoice already Canceled skips the cancel call', async () => {
    setup({ change: changeRow() })
    bcState.oldStatus = 'Canceled'
    expect(await runInvoiceChange(deps, 'ch1')).toBe('done')
    expect(bc.cancelBcInvoice).not.toHaveBeenCalled()
  })

  it("cancel refused → cancel_failed with BC's message; discard returns the order to done unchanged", async () => {
    setup({ change: changeRow(), order: { invoice_state: 'changing' } })
    vi.mocked(bc.cancelBcInvoice).mockRejectedValue(new BcPostRefusedError('The invoice has a payment applied.'))
    expect(await runInvoiceChange(deps, 'ch1')).toBe('cancel_failed')
    expect(change()).toMatchObject({ state: 'cancel_failed', error: 'The invoice has a payment applied.' })
    expect(await discardInvoiceChange(deps, 'ch1')).toEqual({ ok: true })
    expect(change().state).toBe('discarded')
    expect(order()).toMatchObject({ invoice_state: 'done', bc_posted_invoice_id: OLD })
    expect(fake.tables.sales_order_lines[0].quantity).toBe(1)
  })

  it('an invoice that is not Open is never cancelled', async () => {
    setup({ change: changeRow() })
    bcState.oldStatus = 'Paid'
    expect(await runInvoiceChange(deps, 'ch1')).toBe('cancel_failed')
    expect(change().error).toBe("BC shows INV-100411 as Paid; it can't be cancelled.")
    expect(bc.cancelBcInvoice).not.toHaveBeenCalled()
  })

  it('cancel outcome unknown, BC shows Canceled → continues to post without a second cancel', async () => {
    setup({ change: changeRow() })
    vi.mocked(bc.cancelBcInvoice).mockImplementation(async () => {
      bcState.oldStatus = 'Canceled'
      throw new BcPostOutcomeUnknownError('timeout')
    })
    expect(await runInvoiceChange(deps, 'ch1')).toBe('done')
    expect(bc.cancelBcInvoice).toHaveBeenCalledTimes(1)
  })

  it('cancel outcome unknown, BC still Open → cancel_failed with the not-confirmed message', async () => {
    setup({ change: changeRow() })
    vi.mocked(bc.cancelBcInvoice).mockRejectedValue(new BcPostOutcomeUnknownError('timeout'))
    expect(await runInvoiceChange(deps, 'ch1')).toBe('cancel_failed')
    expect(change().error).toBe("BC didn't confirm the cancel. Retry checks BC first, so it won't cancel twice.")
  })

  it('posted replacement already in BC → recorded, no draft, no post', async () => {
    setup({ change: changeRow({ state: 'posting', cancelled_at: T0, draft_bc_invoice_id: 'draft-0' }) })
    bcState.oldStatus = 'Canceled'
    bcState.posted.add('draft-0')
    expect(await runInvoiceChange(deps, 'ch1')).toBe('done')
    expect(bc.createDraftInvoice).not.toHaveBeenCalled()
    expect(bc.postDraftInvoice).not.toHaveBeenCalled()
    expect(change().new_bc_invoice_id).toBe(NEW)
  })

  it('no saved draft means nothing was posted: no Invoice # search (it could find another order\'s invoice)', async () => {
    setup({ change: changeRow({ state: 'posting', cancelled_at: T0 }) })
    bcState.oldStatus = 'Canceled'
    expect(await runInvoiceChange(deps, 'ch1')).toBe('done')
    expect(bc.postDraftInvoice).toHaveBeenCalledTimes(1)
    expect(change()).toMatchObject({ new_bc_invoice_id: NEW, new_bc_invoice_number: 'INV-100415' })
  })

  it('draft saved earlier is reused, not created again', async () => {
    setup({ change: changeRow({ state: 'posting', cancelled_at: T0, draft_bc_invoice_id: 'draft-0' }) })
    bcState.oldStatus = 'Canceled'
    vi.mocked(bc.findDraftInvoice).mockResolvedValue({ id: 'draft-0', no: 'S-INV0' })
    expect(await runInvoiceChange(deps, 'ch1')).toBe('done')
    expect(bc.findDraftInvoice).toHaveBeenCalledWith(deps, { draftId: 'draft-0', externalDocumentNumber: 'W-100528', customerNumber: 'W00389' })
    expect(bc.createDraftInvoice).not.toHaveBeenCalled()
    expect(bc.applyDraftHeader).toHaveBeenCalledWith(deps, { id: 'draft-0', no: 'S-INV0' }, expect.objectContaining({ id: 'o1' }), expect.objectContaining({ id: OLD }))
    expect(bc.setDraftLines).toHaveBeenCalledWith(deps, { id: 'draft-0', no: 'S-INV0' }, after)
  })

  it('draft totals mismatch → post_failed, nothing posted', async () => {
    setup({ change: changeRow() })
    vi.mocked(bc.checkDraft).mockResolvedValue("BC's draft has 1 line totalling $24.50, expected 1 line totalling $49.00.")
    expect(await runInvoiceChange(deps, 'ch1')).toBe('post_failed')
    expect(change()).toMatchObject({ state: 'post_failed', error: "BC's draft has 1 line totalling $24.50, expected 1 line totalling $49.00.", draft_bc_invoice_id: 'draft-1' })
    expect(bc.postDraftInvoice).not.toHaveBeenCalled()
  })

  it("post refused (closed period) → post_failed with BC's message; discard refused after cancel", async () => {
    setup({ change: changeRow(), order: { invoice_state: 'changing' } })
    vi.mocked(bc.postDraftInvoice).mockRejectedValue(new BcPostRefusedError('Posting Date is not within your range of allowed posting dates.'))
    expect(await runInvoiceChange(deps, 'ch1')).toBe('post_failed')
    expect(change().error).toBe('Posting Date is not within your range of allowed posting dates.')
    expect(await discardInvoiceChange(deps, 'ch1')).toEqual({ ok: false, error: 'BC already cancelled INV-100411; Retry to finish the change.' })
    expect(change().state).toBe('post_failed')
    expect(order().invoice_state).toBe('changing')
  })

  it('post outcome unknown and replacement found → posted', async () => {
    setup({ change: changeRow() })
    vi.mocked(bc.postDraftInvoice).mockImplementation(async (_d, draft) => {
      bcState.posted.add(draft.id)
      throw new BcPostOutcomeUnknownError('timeout')
    })
    expect(await runInvoiceChange(deps, 'ch1')).toBe('done')
    expect(change().new_bc_invoice_id).toBe(NEW)
  })

  it('post outcome unknown and nothing posted → post_failed with the not-confirmed message', async () => {
    setup({ change: changeRow() })
    vi.mocked(bc.postDraftInvoice).mockRejectedValue(new BcPostOutcomeUnknownError('timeout'))
    expect(await runInvoiceChange(deps, 'ch1')).toBe('post_failed')
    expect(change().error).toBe("BC didn't confirm the posting. Retry checks BC first, so it won't post twice.")
  })

  it('Bill.com mismatch after PUT → billcom_failed; retry re-runs only the Bill.com step', async () => {
    setup({ change: changeRow() })
    vi.mocked(push.replaceBillcomInvoice).mockResolvedValueOnce({ id: '00eX', totalAmount: 24.62, lineCount: 2 })
    expect(await runInvoiceChange(deps, 'ch1')).toBe('billcom_failed')
    expect(change().error).toContain("Bill.com invoice W-100528 doesn't match")
    expect(order().invoice_state).toBe('changing')
    expect(await retryInvoiceChange(deps, 'ch1')).toEqual({ ok: true })
    expect(change().state).toBe('done')
    expect(bc.cancelBcInvoice).toHaveBeenCalledTimes(1)
    expect(bc.postDraftInvoice).toHaveBeenCalledTimes(1)
    expect(push.replaceBillcomInvoice).toHaveBeenCalledTimes(2)
  })

  it('Bill.com on but no billcom_invoice_id → find-or-create, id saved on the order', async () => {
    setup({ change: changeRow(), order: { billcom_invoice_id: null } })
    expect(await runInvoiceChange(deps, 'ch1')).toBe('done')
    expect(push.findOrCreateBillcomInvoice).toHaveBeenCalledWith(deps.billcom, '0cu1', expect.objectContaining({ invoiceNumber: 'W-100528' }))
    expect(push.replaceBillcomInvoice).not.toHaveBeenCalled()
    expect(order().billcom_invoice_id).toBe('00eNEW')
  })

  it('Bill.com on, no id saved, but the number exists in Bill.com → that invoice is replaced', async () => {
    setup({ change: changeRow(), order: { billcom_invoice_id: null } })
    vi.mocked(push.findBillcomInvoice).mockResolvedValue({ id: '00eHAND', totalAmount: 24.62, lineCount: 2 })
    expect(await runInvoiceChange(deps, 'ch1')).toBe('done')
    expect(vi.mocked(push.replaceBillcomInvoice).mock.calls[0][1]).toBe('00eHAND')
    expect(order().billcom_invoice_id).toBe('00eHAND')
  })

  it('Bill.com off → done without Bill.com', async () => {
    setup({ change: changeRow(), billcom: false })
    expect(await runInvoiceChange(deps, 'ch1')).toBe('done')
    expect(push.replaceBillcomInvoice).not.toHaveBeenCalled()
  })

  it('Bill.com on but unavailable → billcom_failed, never done with the old total left in Bill.com', async () => {
    setup({ change: changeRow(), billcom: false })
    ;(deps as { billcomUnavailable?: boolean }).billcomUnavailable = true
    expect(await runInvoiceChange(deps, 'ch1')).toBe('billcom_failed')
    expect(change()).toMatchObject({ state: 'billcom_failed', error: "Couldn't reach Bill.com. Retry once it's back." })
    expect(order().invoice_state).toBe('changing')
  })

  it('lost lease mid-step → stops without writing', async () => {
    setup({ change: changeRow() })
    vi.mocked(bc.cancelBcInvoice).mockImplementation(async () => {
      order().claimed_until = '2099-01-01T00:00:00.000Z'
      bcState.oldStatus = 'Canceled'
    })
    // The cancel ran; the next renewal finds the lease taken and stops.
    expect(await runInvoiceChange(deps, 'ch1')).toBeNull()
    expect(change().state).toBe('cancelling')
    expect(order().claimed_until).toBe('2099-01-01T00:00:00.000Z')
  })

  it('lease lost while the draft header is written → stops before touching the lines or posting', async () => {
    setup({ change: changeRow() })
    vi.mocked(bc.applyDraftHeader).mockImplementation(async () => {
      order().claimed_until = '2099-01-01T00:00:00.000Z'
    })
    expect(await runInvoiceChange(deps, 'ch1')).toBeNull()
    expect(bc.setDraftLines).not.toHaveBeenCalled()
    expect(bc.postDraftInvoice).not.toHaveBeenCalled()
  })

  it('lease lost while the lines are written → stops before the check and the post', async () => {
    setup({ change: changeRow() })
    vi.mocked(bc.setDraftLines).mockImplementation(async () => {
      order().claimed_until = '2099-01-01T00:00:00.000Z'
    })
    expect(await runInvoiceChange(deps, 'ch1')).toBeNull()
    expect(bc.checkDraft).not.toHaveBeenCalled()
    expect(bc.postDraftInvoice).not.toHaveBeenCalled()
  })

  it('returns null when another runner holds the order', async () => {
    setup({ change: changeRow(), order: { claimed_until: '2026-11-17T10:01:00.000Z' } })
    expect(await runInvoiceChange(deps, 'ch1')).toBeNull()
    expect(bc.readBcInvoice).not.toHaveBeenCalled()
  })

  it('a crash after the order was finished is completed by a re-run', async () => {
    setup({ change: changeRow({ state: 'billcom_updating', cancelled_at: T0, new_bc_invoice_id: NEW, new_bc_invoice_number: 'INV-100415', new_total: 49.24 }), order: { invoice_state: 'done', bc_posted_invoice_id: NEW } })
    expect(await runInvoiceChange(deps, 'ch1')).toBe('done')
    expect(order()).toMatchObject({ invoice_state: 'done', bc_posted_invoice_id: NEW })
  })
})

describe('review fixes', () => {
  it('a BC error before the post (draft header refused) is post_failed with the message, not a silent stop', async () => {
    setup({ change: changeRow() })
    vi.mocked(bc.applyDraftHeader).mockRejectedValue(new Error('Location Code WHS-9 does not exist.'))
    expect(await runInvoiceChange(deps, 'ch1')).toBe('post_failed')
    expect(change()).toMatchObject({ state: 'post_failed', error: 'Location Code WHS-9 does not exist.', draft_bc_invoice_id: 'draft-1' })
    expect(bc.postDraftInvoice).not.toHaveBeenCalled()
  })

  it('a BC read error in the cancel step is cancel_failed with the message', async () => {
    setup({ change: changeRow() })
    vi.mocked(bc.readBcInvoice).mockRejectedValue(new Error('BC is unavailable'))
    expect(await runInvoiceChange(deps, 'ch1')).toBe('cancel_failed')
    expect(change().error).toBe('BC is unavailable')
  })

  it('a BC read error in the Bill.com step is billcom_failed with the message', async () => {
    setup({ change: changeRow({ state: 'billcom_updating', cancelled_at: T0, new_bc_invoice_id: NEW, new_bc_invoice_number: 'INV-100415' }) })
    vi.mocked(bc.readBcInvoice).mockRejectedValue(new Error('BC is unavailable'))
    expect(await runInvoiceChange(deps, 'ch1')).toBe('billcom_failed')
    expect(change().error).toBe('BC is unavailable')
  })

  it('discard asks BC first: refused when BC shows the old invoice cancelled (cancel outcome was unknown)', async () => {
    setup({ change: changeRow({ state: 'cancel_failed', error: "BC didn't confirm the cancel." }) })
    bcState.oldStatus = 'Canceled'
    expect(await discardInvoiceChange(deps, 'ch1')).toEqual({ ok: false, error: 'BC already cancelled INV-100411; Retry to finish the change.' })
    expect(change().state).toBe('cancel_failed')
    expect(order().invoice_state).toBe('changing')
  })

  it("discard refuses when BC can't be read", async () => {
    setup({ change: changeRow({ state: 'cancel_failed' }) })
    vi.mocked(bc.readBcInvoice).mockRejectedValue(new Error('down'))
    expect(await discardInvoiceChange(deps, 'ch1')).toEqual({ ok: false, error: "Couldn't check BC for INV-100411. Try again." })
    expect(change().state).toBe('cancel_failed')
  })

  it('start flips the order first; a database error saving the change puts the order back to done', async () => {
    setup()
    fake.failOn = (t, op) => (t === CHANGES && op === 'insert' ? 'connection reset' : null)
    await expect(start()).rejects.toThrow('connection reset')
    expect(order().invoice_state).toBe('done')
  })
})

describe('retry, discard, sweep, open change', () => {
  it('retry refuses a change with nothing to retry', async () => {
    setup({ change: changeRow({ state: 'done' }) })
    expect(await retryInvoiceChange(deps, 'ch1')).toEqual({ ok: false, error: 'Nothing to retry.' })
  })

  it('sweepInvoiceChanges resumes resumable states whose lease is free, max SWEEP_BATCH', async () => {
    setup({ change: changeRow({ state: 'cancelled', cancelled_at: T0 }) })
    bcState.oldStatus = 'Canceled'
    fake.tables[CHANGES].push(changeRow({ id: 'ch-done', state: 'done' }), changeRow({ id: 'ch-failed', state: 'post_failed' }))
    expect(await sweepInvoiceChanges(deps)).toBe(1)
    expect(change().state).toBe('done')
    expect(fake.tables[CHANGES].find((c) => c.id === 'ch-failed')?.state).toBe('post_failed')
  })

  it('loadOpenChange returns the open change of the order, else null', async () => {
    setup({ change: changeRow({ state: 'post_failed' }) })
    fake.tables[CHANGES].push(changeRow({ id: 'old-done', state: 'done' }))
    expect((await loadOpenChange(deps, 'o1'))?.id).toBe('ch1')
    change().state = 'discarded'
    expect(await loadOpenChange(deps, 'o1')).toBeNull()
  })
})

const listed = (id: string, no: string, totalExclTax = 0) => ({ id, no, totalExclTax, key: { bcId: id }, etag: `W/"${id}"` })
const DUPES = 'BC has more than one draft with Invoice # W-100528 (S-INV102028, S-INV102029). Delete the extra drafts, then Retry.'

describe('duplicate drafts', () => {
  it('more than one draft with the Invoice # → post_failed naming them, nothing set up or posted', async () => {
    setup({ change: changeRow({ state: 'posting', cancelled_at: T0 }) })
    bcState.oldStatus = 'Canceled'
    vi.mocked(bc.listChangeDrafts).mockResolvedValue([listed('d1', 'S-INV102028', 58), listed('d2', 'S-INV102029')])
    expect(await runInvoiceChange(deps, 'ch1')).toBe('post_failed')
    expect(change()).toMatchObject({ state: 'post_failed', error: DUPES })
    expect(bc.listChangeDrafts).toHaveBeenCalledWith(deps, { externalDocumentNumber: 'W-100528', customerNumber: 'W00389' })
    expect(bc.createDraftInvoice).not.toHaveBeenCalled()
    expect(bc.setDraftLines).not.toHaveBeenCalled()
    expect(bc.postDraftInvoice).not.toHaveBeenCalled()
  })

  it('a second draft appearing while the draft was set up → post_failed, not posted', async () => {
    setup({ change: changeRow({ state: 'posting', cancelled_at: T0 }) })
    bcState.oldStatus = 'Canceled'
    vi.mocked(bc.listChangeDrafts)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([listed('d1', 'S-INV102028', 58), listed('d2', 'S-INV102029')])
    expect(await runInvoiceChange(deps, 'ch1')).toBe('post_failed')
    expect(change().error).toBe(DUPES)
    expect(bc.postDraftInvoice).not.toHaveBeenCalled()
  })

  it('findExtraDrafts keeps the saved draft and lists the others', async () => {
    setup({ change: changeRow({ state: 'post_failed', cancelled_at: T0, draft_bc_invoice_id: 'd2', error: DUPES }) })
    bcState.oldStatus = 'Canceled'
    vi.mocked(bc.listChangeDrafts).mockResolvedValue([listed('d1', 'S-INV102028', 0), listed('d2', 'S-INV102029', 58)])
    expect(await findExtraDrafts(deps, 'ch1')).toEqual({
      ok: true,
      keep: { id: 'd2', no: 'S-INV102029', totalExclTax: 58 },
      extra: [{ id: 'd1', no: 'S-INV102028', totalExclTax: 0 }],
    })
  })

  it('findExtraDrafts without a saved draft keeps the first; refuses a change not stopped at the post', async () => {
    setup({ change: changeRow({ state: 'post_failed', cancelled_at: T0, error: DUPES }) })
    bcState.oldStatus = 'Canceled'
    vi.mocked(bc.listChangeDrafts).mockResolvedValue([listed('d1', 'S-INV102028'), listed('d2', 'S-INV102029')])
    expect(await findExtraDrafts(deps, 'ch1')).toMatchObject({ ok: true, keep: { id: 'd1' }, extra: [{ id: 'd2' }] })
    change().state = 'billcom_failed'
    expect(await findExtraDrafts(deps, 'ch1')).toEqual({ ok: false, error: 'Nothing to clean up.' })
  })

  it('deleteExtraDrafts deletes only the confirmed extras, never the kept draft, and says to Retry', async () => {
    setup({ change: changeRow({ state: 'post_failed', cancelled_at: T0, draft_bc_invoice_id: 'd1', error: DUPES }) })
    bcState.oldStatus = 'Canceled'
    vi.mocked(bc.listChangeDrafts).mockResolvedValue([listed('d1', 'S-INV102028', 58), listed('d2', 'S-INV102029'), listed('d3', 'S-INV102031')])
    expect(await deleteExtraDrafts(deps, 'ch1', ['d1', 'd2'])).toEqual({ ok: true })
    expect(bc.deleteDraftInvoice).toHaveBeenCalledTimes(1)
    expect(bc.deleteDraftInvoice).toHaveBeenCalledWith(deps, listed('d2', 'S-INV102029'))
    expect(change()).toMatchObject({ state: 'post_failed', error: 'Deleted S-INV102029. Retry to post the corrected invoice.' })
  })

  it('deleteExtraDrafts does nothing unless the change is stopped at the post, or when the order is busy', async () => {
    setup({ change: changeRow({ state: 'posting', cancelled_at: T0, draft_bc_invoice_id: 'd1' }) })
    vi.mocked(bc.listChangeDrafts).mockResolvedValue([listed('d1', 'S-INV102028'), listed('d2', 'S-INV102029')])
    expect(await deleteExtraDrafts(deps, 'ch1', ['d2'])).toEqual({ ok: false, error: 'Nothing to clean up.' })
    change().state = 'post_failed'
    order().claimed_until = '2026-11-17T11:00:00.000Z'
    expect(await deleteExtraDrafts(deps, 'ch1', ['d2'])).toMatchObject({ ok: false })
    expect(bc.deleteDraftInvoice).not.toHaveBeenCalled()
  })
})
