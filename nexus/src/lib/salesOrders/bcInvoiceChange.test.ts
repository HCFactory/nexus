import { describe, expect, it, vi } from 'vitest'

import { BcApiError } from '@/lib/businessCentral/client'
import type { BcKey, BcRecord, ReferenceSource, ReferenceTransport } from '@/lib/businessCentral/customerReferences/transport'
import type { ChangeLine } from '@/types/invoiceChanges'
import type { SalesOrderRow } from '@/types/salesOrders'
import {
  cancelBcInvoice,
  checkDraft,
  applyDraftHeader,
  createDraftInvoice,
  deleteDraftInvoice,
  listChangeDrafts,
  findDraftInvoice,
  postDraftInvoice,
  readBcInvoice,
  setDraftLines,
} from './bcInvoiceChange'
import { BcPostOutcomeUnknownError, BcPostRefusedError, type BcInvoicingDeps, type PostedInvoice } from './bcInvoicing'

const OLD_ID = '143fbb46-e8e0-f111-84e4-7ced8d88ddac'

const rec = (fields: Record<string, unknown>, etag = 'W/"1"'): BcRecord => ({ key: { bcId: String(fields.id ?? 'x') }, etag, fields })

const inv = (over: Record<string, unknown> = {}) => ({
  id: OLD_ID,
  number: 'INV-100411',
  status: 'Open',
  externalDocumentNumber: 'W-100528',
  customerNumber: 'W00389',
  invoiceDate: '2026-11-15',
  dueDate: '2026-12-15',
  totalAmountExcludingTax: 24.5,
  totalTaxAmount: 0.12,
  totalAmountIncludingTax: 24.62,
  ...over,
})

type Handler = (s: ReferenceSource, o?: { filter?: string }) => BcRecord[]

function makeDeps(opts: { list?: Handler; invokeAction?: (p: string) => Promise<void>; create?: (s: ReferenceSource, f: Record<string, unknown>) => BcRecord } = {}) {
  const list = vi.fn(async (s: ReferenceSource, o?: { filter?: string }) => (opts.list ? opts.list(s, o) : []))
  const get = vi.fn(async (_s: ReferenceSource, key: BcKey) => rec({ id: 'values' in key ? key.values.id : 'x', shipToCode: '' }, 'W/"doc"'))
  const patch = vi.fn(async (_s: ReferenceSource, _k: BcKey, _e: string, f: Record<string, unknown>) => rec({ ...f }, 'W/"doc2"'))
  const create = vi.fn(async (s: ReferenceSource, f: Record<string, unknown>) => (opts.create ? opts.create(s, f) : rec({ id: 'draft-id', number: 'S-INV102030', ...f })))
  const remove = vi.fn(async () => undefined)
  const transport = { list, get, patch, create, remove } as unknown as ReferenceTransport
  const invokeAction = vi.fn(opts.invokeAction ?? (async () => undefined))
  const deps = { supabase: {} as never, transport, orgId: 'o', connectionId: 'c', now: () => 'now', invokeAction } as BcInvoicingDeps
  return { deps, list, get, patch, create, remove, invokeAction }
}

const apiError = (status: number, message: string) => new BcApiError({ status, statusText: 'x', message, url: 'u' })

const line = (over: Partial<ChangeLine> = {}): ChangeLine => ({
  item_number: '20000', description: 'Candy', unit_of_measure_code: 'BOX', quantity: 2, unit_price: 24.5, discount_percent: 10, ...over,
})

describe('readBcInvoice', () => {
  it('reads by id (unquoted GUID) and returns status with totals', async () => {
    const { deps, list } = makeDeps({ list: () => [rec(inv())] })
    expect(await readBcInvoice(deps, OLD_ID)).toMatchObject({ id: OLD_ID, number: 'INV-100411', status: 'Open', totalInclTax: 24.62, externalDocumentNumber: 'W-100528' })
    expect(list.mock.calls[0][0]).toEqual({ kind: 'api', resource: 'salesInvoices' })
    expect(list.mock.calls[0][1]?.filter).toBe(`id eq ${OLD_ID}`)
  })

  it('returns null when BC has no such invoice', async () => {
    expect(await readBcInvoice(makeDeps().deps, OLD_ID)).toBeNull()
  })
})

describe('cancelBcInvoice', () => {
  it('invokes the cancel action on the invoice', async () => {
    const { deps, invokeAction } = makeDeps()
    await cancelBcInvoice(deps, OLD_ID)
    expect(invokeAction).toHaveBeenCalledWith(`/salesInvoices(${OLD_ID})/Microsoft.NAV.cancel`)
  })

  it("a 400 is a refusal carrying BC's message", async () => {
    const { deps } = makeDeps({ invokeAction: async () => { throw apiError(400, 'The invoice is paid.') } })
    await expect(cancelBcInvoice(deps, OLD_ID)).rejects.toEqual(new BcPostRefusedError('The invoice is paid.'))
  })

  it('a 504 is an unknown outcome', async () => {
    const { deps } = makeDeps({ invokeAction: async () => { throw apiError(504, 'timeout') } })
    await expect(cancelBcInvoice(deps, OLD_ID)).rejects.toBeInstanceOf(BcPostOutcomeUnknownError)
  })
})

describe('findDraftInvoice', () => {
  it('prefers the saved draft id while it is still a draft', async () => {
    const { deps, list } = makeDeps({ list: (_s, o) => (o?.filter === 'id eq draft-id' ? [rec(inv({ id: 'draft-id', number: 'S-INV1', status: 'Draft' }))] : []) })
    expect(await findDraftInvoice(deps, { draftId: 'draft-id', externalDocumentNumber: 'W-100528', customerNumber: 'W00389' })).toEqual({ id: 'draft-id', no: 'S-INV1' })
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('falls back to a draft with the same Invoice # and customer', async () => {
    const { deps, list } = makeDeps({
      list: (_s, o) => (o?.filter?.includes("status eq 'Draft'") ? [rec(inv({ id: 'orphan', number: 'S-INV2', status: 'Draft' }))] : []),
    })
    expect(await findDraftInvoice(deps, { draftId: null, externalDocumentNumber: 'W-100528', customerNumber: 'W00389' })).toEqual({ id: 'orphan', no: 'S-INV2' })
    expect(list.mock.calls[0][1]?.filter).toBe("externalDocumentNumber eq 'W-100528' and customerNumber eq 'W00389' and status eq 'Draft'")
  })

  it('a blank Invoice # never falls back to a search (it would match any blank-numbered draft of the customer)', async () => {
    const { deps, list } = makeDeps({ list: () => [rec(inv({ id: 'other', number: 'S-INV9', status: 'Draft', externalDocumentNumber: '' }))] })
    expect(await findDraftInvoice(deps, { draftId: null, externalDocumentNumber: '  ', customerNumber: 'W00389' })).toBeNull()
    expect(list).not.toHaveBeenCalled()
  })

  it('returns null when there is no draft', async () => {
    expect(await findDraftInvoice(makeDeps().deps, { draftId: 'gone', externalDocumentNumber: 'W-100528', customerNumber: 'W00389' })).toBeNull()
  })
})

describe('createDraftInvoice', () => {
  const order = {
    customer_number: 'W00389', ship_to_code: '', ship_to_name: 'Shop', ship_to_address: '1 Main', ship_to_address_2: '', ship_to_city: 'Honolulu',
    ship_to_state: 'HI', ship_to_post_code: '96813', ship_to_country: 'US', ship_to_contact: '', ship_to_phone: '',
    tax_area_code: 'HI-HNL-WHSL', tax_liable: true, location_code: 'WHS-1', gen_bus_posting_group: 'US', customer_posting_group: 'US',
    payment_terms_code: '30 DAYS', shipment_method_code: '',
  } as unknown as SalesOrderRow
  const old: PostedInvoice = { id: OLD_ID, number: 'INV-100411', invoiceDate: '2026-11-15', dueDate: '2026-12-15', totalExclTax: 24.5, totalTax: 0.12, totalInclTax: 24.62 }

  it('creates the draft header with the old dates (and nothing else)', async () => {
    const { deps, create, patch } = makeDeps()
    expect(await createDraftInvoice(deps, order, old, 'W-100528')).toEqual({ id: 'draft-id', no: 'S-INV102030' })
    expect(create.mock.calls[0][0]).toEqual({ kind: 'api', resource: 'salesInvoices' })
    expect(create.mock.calls[0][1]).toEqual({ customerNumber: 'W00389', externalDocumentNumber: 'W-100528', invoiceDate: '2026-11-15', postingDate: '2026-11-15', dueDate: '2026-12-15' })
    expect(patch).not.toHaveBeenCalled()
  })

  it('applyDraftHeader: the ship-to, then tax/location/posting with the dates (safe to repeat)', async () => {
    const { deps, patch } = makeDeps()
    await applyDraftHeader(deps, { id: 'draft-id', no: 'S-INV1' }, order, old)
    expect(patch).toHaveBeenCalledTimes(2)
    expect(patch.mock.calls[0][1]).toEqual({ values: { id: 'draft-id' } })
    expect(patch.mock.calls[0][3]).toMatchObject({ shipToName: 'Shop', shipToCity: 'Honolulu' })
    expect(patch.mock.calls[1][2]).toBe('W/"doc2"')
    expect(patch.mock.calls[1][3]).toEqual({
      taxAreaCode: 'HI-HNL-WHSL', taxLiable: true, locationCode: 'WHS-1', genBusPostingGroup: 'US', customerPostingGroup: 'US',
      paymentTermsCode: '30 DAYS', shipmentMethodCode: '', postingDate: '2026-11-15', documentDate: '2026-11-15', dueDate: '2026-12-15',
    })
  })

  it('a ship-to code is sent as the code, not as an address', async () => {
    const { deps, patch } = makeDeps()
    await applyDraftHeader(deps, { id: 'draft-id', no: 'S-INV1' }, { ...order, ship_to_code: 'STORE2' } as SalesOrderRow, old)
    expect(patch.mock.calls[0][3]).toEqual({ shipToCode: 'STORE2' })
  })
})

describe('setDraftLines', () => {
  it('removes the existing lines, then adds each line with price, discount, UOM and description', async () => {
    const { deps, remove, create } = makeDeps({ list: () => [rec({ id: 'l1' }, 'W/"a"'), rec({ id: 'l2' }, 'W/"b"')] })
    await setDraftLines(deps, { id: 'draft-id', no: 'S-INV1' }, [line(), line({ item_number: 'P-10', unit_of_measure_code: '', quantity: 1, unit_price: 3.33, discount_percent: 0 })])
    const src = { kind: 'api', resource: 'salesInvoices(draft-id)/salesInvoiceLines' }
    expect(remove.mock.calls).toEqual([[src, { bcId: 'l1' }, 'W/"a"'], [src, { bcId: 'l2' }, 'W/"b"']])
    expect(create.mock.calls).toEqual([
      [src, { lineType: 'Item', lineObjectNumber: '20000', description: 'Candy', unitOfMeasureCode: 'BOX', quantity: 2, unitPrice: 24.5, discountPercent: 10 }],
      [src, { lineType: 'Item', lineObjectNumber: 'P-10', description: 'Candy', quantity: 1, unitPrice: 3.33, discountPercent: 0 }],
    ])
  })
})

describe('checkDraft', () => {
  const lines = [line(), line({ quantity: 1, unit_price: 3.33, discount_percent: 0 })]
  const draft = { id: 'draft-id', no: 'S-INV1' }

  it('null when the line count and subtotal match', async () => {
    const { deps } = makeDeps({
      list: (s) => (s.kind === 'api' && s.resource.endsWith('salesInvoiceLines') ? [rec({ id: 'a' }), rec({ id: 'b' })] : [rec(inv({ id: 'draft-id', status: 'Draft', totalAmountExcludingTax: 47.43 }))]),
    })
    expect(await checkDraft(deps, draft, lines)).toBeNull()
  })

  it('says what differs', async () => {
    const { deps } = makeDeps({
      list: (s) => (s.kind === 'api' && s.resource.endsWith('salesInvoiceLines') ? [rec({ id: 'a' }), rec({ id: 'b' })] : [rec(inv({ id: 'draft-id', status: 'Draft', totalAmountExcludingTax: 5 }))]),
    })
    expect(await checkDraft(deps, draft, [...lines, line({ quantity: 1, unit_price: 1, discount_percent: 0 })])).toBe(
      "BC's draft has 2 lines totalling $5.00, expected 3 lines totalling $48.43.",
    )
  })

  it('allows a rounding difference of up to 1 cent per line, not more', async () => {
    const at = (total: number) =>
      makeDeps({
        list: (s) => (s.kind === 'api' && s.resource.endsWith('salesInvoiceLines') ? [rec({ id: 'a' }), rec({ id: 'b' })] : [rec(inv({ id: 'draft-id', status: 'Draft', totalAmountExcludingTax: total }))]),
      }).deps
    expect(await checkDraft(at(47.45), draft, lines)).toBeNull()
    expect(await checkDraft(at(47.41), draft, lines)).toBeNull()
    expect(await checkDraft(at(47.46), draft, lines)).not.toBeNull()
  })
})

describe('postDraftInvoice', () => {
  it('invokes post on the draft; a 400 is a refusal with BC message', async () => {
    const ok = makeDeps()
    await postDraftInvoice(ok.deps, { id: 'draft-id', no: 'S-INV1' })
    expect(ok.invokeAction).toHaveBeenCalledWith('/salesInvoices(draft-id)/Microsoft.NAV.post')
    const refused = makeDeps({ invokeAction: async () => { throw apiError(400, 'Posting Date is not within your range of allowed posting dates.') } })
    await expect(postDraftInvoice(refused.deps, { id: 'draft-id', no: 'S-INV1' })).rejects.toEqual(
      new BcPostRefusedError('Posting Date is not within your range of allowed posting dates.'),
    )
  })
})

describe('listChangeDrafts', () => {
  it('lists every draft with this Invoice # and customer, with number and subtotal', async () => {
    const { deps, list } = makeDeps({
      list: () => [
        rec({ id: 'd1', number: 'S-INV102028', status: 'Draft', totalAmountExcludingTax: 58 }, 'W/"a"'),
        rec({ id: 'd2', number: 'S-INV102029', status: 'Draft', totalAmountExcludingTax: 0 }, 'W/"b"'),
      ],
    })
    expect(await listChangeDrafts(deps, { externalDocumentNumber: 'W-100532', customerNumber: 'W00389' })).toEqual([
      { id: 'd1', no: 'S-INV102028', totalExclTax: 58, key: { bcId: 'd1' }, etag: 'W/"a"' },
      { id: 'd2', no: 'S-INV102029', totalExclTax: 0, key: { bcId: 'd2' }, etag: 'W/"b"' },
    ])
    expect(list.mock.calls[0][1]?.filter).toBe("externalDocumentNumber eq 'W-100532' and customerNumber eq 'W00389' and status eq 'Draft'")
  })
})

describe('listChangeDrafts with a blank Invoice #', () => {
  it('lists nothing and asks BC nothing', async () => {
    const { deps, list } = makeDeps({ list: () => [rec({ id: 'd1', number: 'S-INV1', status: 'Draft' })] })
    expect(await listChangeDrafts(deps, { externalDocumentNumber: '', customerNumber: 'W00389' })).toEqual([])
    expect(list).not.toHaveBeenCalled()
  })
})

describe('deleteDraftInvoice', () => {
  it('deletes the draft invoice with its etag', async () => {
    const { deps, remove } = makeDeps()
    await deleteDraftInvoice(deps, { id: 'd2', no: 'S-INV102029', totalExclTax: 0, key: { bcId: 'd2' }, etag: 'W/"b"' })
    expect(remove).toHaveBeenCalledWith({ kind: 'api', resource: 'salesInvoices' }, { bcId: 'd2' }, 'W/"b"')
  })
})
