import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BcConflictError, BcReferenceError } from '@/lib/businessCentral/customerReferences/errors'
import type { BcKey, BcRecord, ReferenceSource } from '@/lib/businessCentral/customerReferences/transport'
import type { SalesOrderLineRow, SalesOrderRow } from '@/types/salesOrders'
import { HEADER_SNAPSHOT_FIELDS, createMarker, snapshotOf } from './bcOrderMapping'
import { deleteSalesOrderInBc, syncSalesOrder, type OrderSyncDeps } from './orderSync'

type Row = Record<string, unknown>
type Result = { data: Row[]; error: { message: string } | null }

function fakeSupabase(tables: Record<string, Row[]>): SupabaseClient {
  let nextId = 1
  const from = (table: string) => {
    tables[table] ??= []
    const filters: [string, unknown][] = []
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
    let payload: Row = {}
    let orderBy: string | null = null
    const exec = (): Result => {
      if (op === 'insert') {
        const row = { id: `gen-${nextId++}`, ...payload }
        tables[table].push(row)
        return { data: [row], error: null }
      }
      const rows = tables[table].filter((r) => filters.every(([k, v]) => r[k] === v))
      if (op === 'update') rows.forEach((r) => Object.assign(r, payload))
      if (op === 'delete') tables[table] = tables[table].filter((r) => !rows.includes(r))
      const out = rows.map((r) => ({ ...r }))
      if (orderBy) out.sort((a, b) => Number(a[orderBy!]) - Number(b[orderBy!]))
      return { data: out, error: null }
    }
    const b = {
      select: () => b,
      insert: (p: Row) => { op = 'insert'; payload = p; return b },
      update: (p: Row) => { op = 'update'; payload = p; return b },
      delete: () => { op = 'delete'; return b },
      eq: (k: string, v: unknown) => { filters.push([k, v]); return b },
      order: (k: string) => { orderBy = k; return b },
      maybeSingle: async () => { const r = exec(); return { data: r.data[0] ?? null, error: r.error } },
      single: async () => { const r = exec(); return { data: r.data[0] ?? null, error: r.data[0] ? null : { message: 'no row' } } },
      then: (res: (r: Result) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(exec()).then(res, rej),
    }
    return b
  }
  return { from } as unknown as SupabaseClient
}

/** Fake BC: SalesOrder headers by No, SalesOrderSalesLines by `No|Line_No`. Enforces etags. */
function fakeBc() {
  let etagN = 1
  let orderN = 1001
  const headers = new Map<string, BcRecord>()
  const lines = new Map<string, BcRecord>()
  const nextLineNo = new Map<string, number>()
  /** Ship-to addresses that exist in BC, as `Customer_No|Code`. */
  const shipTos = new Set<string>(['C100|WH1', 'C200|WH1'])
  /** salesDocuments ids (the Sales Header SystemId), by order No; assigned on first use. */
  const ids = new Map<string, string>()
  const idFor = (no: string) => {
    if (!ids.has(no)) ids.set(no, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`)
    return ids.get(no)!
  }
  const isDoc = (s: ReferenceSource) => s.kind === 'odata' && s.service === 'salesDocuments'
  /** salesDocuments camelCase field -> SalesOrder page field (same Sales Header record). */
  const DOC_FIELDS: Record<string, string> = {
    shipToCode: 'Ship_to_Code', shipToName: 'Ship_to_Name', shipToAddress: 'Ship_to_Address',
    shipToAddress2: 'Ship_to_Address_2', shipToCity: 'Ship_to_City', shipToCounty: 'Ship_to_County',
    shipToPostCode: 'Ship_to_Post_Code', shipToCountryRegionCode: 'Ship_to_Country_Region_Code',
    shipToContact: 'Ship_to_Contact', shipToPhoneNo: 'Ship_to_Phone_No',
  }
  /** The salesDocuments view of a header. Its etag moves with the header's (same record). */
  const docView = (no: string): BcRecord => {
    const h = headers.get(no)!
    const fields: Record<string, unknown> = { id: idFor(no), documentType: 'Order', number: no }
    for (const [camel, pascal] of Object.entries(DOC_FIELDS)) fields[camel] = h.fields[pascal] ?? ''
    // Real BC (TEST, measured): the header totals live here (amount, amountIncludingVAT).
    const tot = totals(no)
    fields.amount = tot.excl
    fields.amountIncludingVAT = tot.incl
    return { key: { values: { id: idFor(no) } }, etag: `D-${h.etag}`, fields }
  }
  const noForId = (id: string) => [...ids].find(([, v]) => v === id)?.[0]
  /** Called before every transport call; throw from it to make that call fail. */
  const hooks: { before?: (method: string, source: ReferenceSource, arg: unknown) => void } = {}
  const etag = () => `W/"e${etagN++}"`
  const isLine = (s: ReferenceSource) => s.kind === 'odata' && s.service === 'SalesOrderSalesLines'
  const keyOf = (s: ReferenceSource, k: BcKey) => {
    if (!('values' in k)) throw new Error('expected values key')
    if (isDoc(s)) {
      expect(s.kind === 'odata' && s.guidKeyFields).toEqual(['id'])
      return k.values.id
    }
    expect(k.values.Document_Type).toBe('Order')
    if (isLine(s)) {
      expect(typeof k.values.Line_No).toBe('string')
      // Real BC (TEST, measured): a quoted Line_No='10000' answers 404 "key not valid".
      if (!(s.kind === 'odata' && s.integerKeyFields?.includes('Line_No'))) {
        throw new BcReferenceError(404, 'The key in the request URI is not valid')
      }
      return `${k.values.Document_No}|${k.values.Line_No}`
    }
    return k.values.No
  }
  const store = (s: ReferenceSource) => (isLine(s) ? lines : headers)
  /** Real BC (TEST, measured): a line insert (and delete) changes the header etag; a line patch doesn't. */
  const touchHeader = (docNo: string) => {
    const h = headers.get(docNo)
    if (h) headers.set(docNo, { ...h, etag: etag() })
  }
  const totals = (docNo: string) => {
    const ls = [...lines.values()].filter((l) => l.fields.Document_No === docNo)
    const excl = ls.reduce((a, l) => a + Number(l.fields.Quantity) * Number(l.fields.Unit_Price), 0)
    return { excl, incl: Math.round(excl * 1.1 * 100) / 100 }
  }
  /** Real BC (TEST, measured W-100528): the line Total_* fields are page-computed and come back 0 over OData. */
  const withTotals = (r: BcRecord): BcRecord =>
    ({ ...r, fields: { ...r.fields, Total_Amount_Excl_VAT: 0, Total_VAT_Amount: 0, Total_Amount_Incl_VAT: 0 } })

  const t = {
    list: vi.fn(async (s: ReferenceSource, opts: { filter?: string } = {}) => {
      hooks.before?.('list', s, opts)
      const f = opts.filter ?? ''
      if (isDoc(s)) {
        expect(f).toContain("documentType eq 'Order'")
        const m = /number eq '([^']+)'/.exec(f)
        return m && headers.has(m[1]) ? [docView(m[1])] : []
      }
      if (isLine(s)) {
        const m = /Document_No eq '([^']+)'/.exec(f)
        return [...lines.values()].filter((l) => !m || l.fields.Document_No === m[1]).map(withTotals)
      }
      const m = /External_Document_No eq '([^']+)'/.exec(f)
      return [...headers.values()].filter((h) => !m || h.fields.External_Document_No === m[1])
    }),
    get: vi.fn(async (s: ReferenceSource, key: BcKey) => {
      hooks.before?.('get', s, key)
      if (isDoc(s)) {
        const no = noForId(keyOf(s, key))
        if (!no || !headers.has(no)) throw new BcReferenceError(404, 'not found')
        return docView(no)
      }
      const r = store(s).get(keyOf(s, key))
      if (!r) throw new BcReferenceError(404, 'not found')
      return r
    }),
    create: vi.fn(async (s: ReferenceSource, fields: Record<string, unknown>) => {
      hooks.before?.('create', s, fields)
      if (isLine(s)) {
        const docNo = String(fields.Document_No)
        if (!headers.has(docNo)) throw new BcReferenceError(400, 'no header')
        const n = (nextLineNo.get(docNo) ?? 0) + 10000
        nextLineNo.set(docNo, n)
        const rec: BcRecord = {
          key: { values: { Document_Type: 'Order', Document_No: docNo, Line_No: String(n) } },
          etag: etag(),
          fields: { Unit_Price: 9.99, ...fields, Line_No: n, Amount_Including_VAT: 1 },
        }
        lines.set(`${docNo}|${n}`, rec)
        touchHeader(docNo)
        return rec
      }
      const no = `SO${orderN++}`
      const rec: BcRecord = { key: { values: { Document_Type: 'Order', No: no } }, etag: etag(), fields: { Ship_to_Code: '', ...fields, No: no, Due_Date: '2026-12-01' } }
      headers.set(no, rec)
      return rec
    }),
    patch: vi.fn(async (s: ReferenceSource, key: BcKey, e: string, fields: Record<string, unknown>) => {
      hooks.before?.('patch', s, fields)
      if (isDoc(s)) {
        // Real BC (TEST, measured): salesDocuments accepts shipToCode (BC fills
        // the address from the ship-to; '' fills it from the customer) and the
        // ship-to address fields. Same record as SalesOrder: its etag changes.
        const no = noForId(keyOf(s, key))
        const h = no ? headers.get(no) : undefined
        if (!no || !h) throw new BcReferenceError(404, 'not found')
        if (`D-${h.etag}` !== e) throw new BcConflictError()
        let next = { ...h.fields }
        if ('shipToCode' in fields) {
          const code = String(fields.shipToCode)
          if (code !== '' && !shipTos.has(`${h.fields.Sell_to_Customer_No}|${code}`)) {
            throw new BcReferenceError(400, 'The Ship-to Address does not exist.')
          }
          next = code === ''
            ? { ...next, Ship_to_Name: 'CUST NAME', Ship_to_Address: 'cust st', Ship_to_City: 'cust city' }
            : { ...next, Ship_to_Name: `${code} name`, Ship_to_Address: `${code} st`, Ship_to_City: `${code} city` }
        }
        for (const [camel, v] of Object.entries(fields)) {
          if (!(camel in DOC_FIELDS)) throw new BcReferenceError(400, `unexpected salesDocuments field ${camel}`)
          next[DOC_FIELDS[camel]] = v
        }
        headers.set(no, { ...h, etag: etag(), fields: next })
        return docView(no)
      }
      const k = keyOf(s, key)
      const r = store(s).get(k)
      if (!r) throw new BcReferenceError(404, 'not found')
      if (r.etag !== e) throw new BcConflictError()
      let base = r.fields
      if (!isLine(s)) {
        // Real BC (TEST, measured): switching Sell_to_Customer_No on an order with
        // lines works and keeps the lines; BC refills the customer's defaults.
        if ('Sell_to_Customer_No' in fields && fields.Sell_to_Customer_No !== r.fields.Sell_to_Customer_No) {
          base = { ...base, Ship_to_Code: '', Payment_Terms_Code: 'BC-DEFAULT', Location_Code: 'BC-LOC', Tax_Area_Code: 'BC-TAX' }
        }
        // Real BC (TEST, measured): on page 42 every Ship_to_* field is read-only
        // (ShippingOptions can't be set through OData).
        const ro = Object.keys(fields).find((f) => f.startsWith('Ship_to_'))
        if (ro) throw new BcReferenceError(400, `Control '${ro}' is read-only`)
      }
      const next = { ...r, etag: etag(), fields: { ...base, ...fields } }
      store(s).set(k, next)
      // Real BC (TEST, measured): a header Tax_Area_Code patch is pushed to the lines, changing their etags.
      if (!isLine(s) && 'Tax_Area_Code' in fields) {
        for (const [lk, l] of lines) if (l.fields.Document_No === k) lines.set(lk, { ...l, etag: etag() })
      }
      return next
    }),
    remove: vi.fn(async (s: ReferenceSource, key: BcKey, e: string) => {
      hooks.before?.('remove', s, key)
      const k = keyOf(s, key)
      const r = store(s).get(k)
      if (!r) throw new BcReferenceError(404, 'not found')
      if (r.etag !== e) throw new BcConflictError()
      store(s).delete(k)
      if (isLine(s)) touchHeader(String(r.fields.Document_No))
    }),
  }
  return { t, headers, lines, hooks, etag, shipTos }
}

const ORDER_ID = 'abcdef12-3456-7890-abcd-ef1234567890'

function order(over: Partial<SalesOrderRow> = {}): SalesOrderRow {
  return {
    id: ORDER_ID,
    organization_id: 'org', bc_connection_id: 'conn', status: 'final',
    customer_id: 'cu', customer_number: 'C100',
    order_date: '2026-11-01', requested_delivery_date: null,
    invoice_number: null, customer_po: 'PO-SECRET', notes: 'NOTE-SECRET',
    bill_name: 'Bill', bill_address: 'a1', bill_address_2: '', bill_city: 'bc',
    bill_state: 'bs', bill_post_code: 'bp', bill_country: 'US', bill_contact_no: '',
    bill_phone: '', bill_mobile: '', bill_email: '', bill_email_cc: '',
    ship_to_code: 'WH1', ship_to_name: 'sn', ship_to_address: 'sa', ship_to_address_2: '',
    ship_to_city: 'sc', ship_to_state: 'ss', ship_to_post_code: 'sp', ship_to_country: 'US',
    ship_to_contact: '', ship_to_phone: '',
    payment_terms_code: 'NET30', tax_area_code: 'TX', gen_bus_posting_group: 'DOM',
    customer_posting_group: 'CP', shipment_method_code: 'UPS', location_code: 'MAIN',
    tax_liable: true, bc_order_number: null, bc_etag: null, bc_create_marker: null,
    bc_due_date: null, bc_document_date: null, bc_posting_date: null,
    total_excl_tax: null, total_tax: null, total_incl_tax: null,
    sync_state: 'pending', sync_error: null, sync_attempts: 0, claimed_until: null,
    last_synced_at: null, local_version: 3, synced_version: 0, created_by: null,
    bc_snapshot: null, created_at: '', updated_at: '',
    ...over,
  }
}

function line(over: Partial<SalesOrderLineRow> = {}): SalesOrderLineRow {
  return {
    id: 'l1', organization_id: 'org', bc_connection_id: 'conn', sales_order_id: ORDER_ID, position: 1,
    item_number: 'ITEM1', description: 'd', unit_of_measure_code: 'PCS', quantity: 2,
    unit_price: 5, discount_percent: 0, removed: false, bc_line_no: null, bc_etag: null,
    bc_unit_price: null, bc_line_discount_percent: null, amount_incl_tax: null, bc_snapshot: null, created_at: '', updated_at: '',
    ...over,
  }
}

let tables: Record<string, Row[]>
let bc: ReturnType<typeof fakeBc>
let deps: OrderSyncDeps

const orderRow = () => tables.sales_orders.find((r) => r.id === ORDER_ID)!
const lineRow = (id: string) => tables.sales_order_lines.find((r) => r.id === id)
const isLineSource = (s: ReferenceSource) => s.kind === 'odata' && s.service === 'SalesOrderSalesLines'
const lineCreates = () => bc.t.create.mock.calls.filter(([s]) => isLineSource(s))
const headerCreates = () => bc.t.create.mock.calls.filter(([s]) => !isLineSource(s))
const isDocSource = (s: ReferenceSource) => s.kind === 'odata' && s.service === 'salesDocuments'
const headerPatches = () => bc.t.patch.mock.calls.filter(([s]) => !isLineSource(s) && !isDocSource(s))
const docPatches = () => bc.t.patch.mock.calls.filter(([s]) => isDocSource(s))

function setup(o: SalesOrderRow, ls: SalesOrderLineRow[]) {
  tables = {
    sales_orders: [
      { ...o } as unknown as Row,
      // same id in another org must never be touched
      { ...o, organization_id: 'other', local_version: 99 } as unknown as Row,
    ],
    sales_order_lines: ls.map((l) => ({ ...l }) as unknown as Row),
    customer_ship_to_addresses: [
      { organization_id: 'org', bc_connection_id: 'conn', customer_number: 'C100', code: 'WH1' },
      { organization_id: 'org', bc_connection_id: 'conn', customer_number: 'C200', code: 'WH1' },
      // same code in another org must not count
      { organization_id: 'other', bc_connection_id: 'conn', customer_number: 'C100', code: 'GONE' },
    ],
  }
  deps = { supabase: fakeSupabase(tables), transport: bc.t, orgId: 'org', connectionId: 'conn', now: () => '2026-11-13T10:00:00Z' }
}

/** Puts an already-synced order (with lines) into the fake BC and returns its stored rows. */
function seedSynced(lineSpecs: { id: string; no: number; item?: string }[]) {
  const hEtag = bc.etag()
  bc.headers.set('SO900', { key: { values: { Document_Type: 'Order', No: 'SO900' } }, etag: hEtag, fields: { No: 'SO900', External_Document_No: 'SO900', Sell_to_Customer_No: 'C100', Ship_to_Code: 'WH1' } })
  const rows = lineSpecs.map((s) => {
    const e = bc.etag()
    bc.lines.set(`SO900|${s.no}`, {
      key: { values: { Document_Type: 'Order', Document_No: 'SO900', Line_No: String(s.no) } },
      etag: e,
      fields: { Document_Type: 'Order', Document_No: 'SO900', Line_No: s.no, Type: 'Item', No: s.item ?? 'ITEM1', Quantity: 2, Unit_Price: 5, Line_Discount_Percent: 0, Unit_of_Measure_Code: 'PCS', Location_Code: 'MAIN' },
    })
    return line({ id: s.id, position: s.no / 10000, item_number: s.item ?? 'ITEM1', bc_line_no: s.no, bc_etag: e })
  })
  return { hEtag, rows }
}

beforeEach(() => {
  bc = fakeBc()
})

describe('syncSalesOrder: first sync', () => {
  it('creates the order, sets the ship-to through salesDocuments, patches the header, creates each line, and ends synced with BC totals', async () => {
    setup(order(), [line({ id: 'l1', position: 1 }), line({ id: 'l2', position: 2, item_number: 'ITEM2', unit_price: null })])

    const state = await syncSalesOrder(deps, ORDER_ID)

    expect(state).toBe('synced')
    expect(headerCreates()).toHaveLength(1)
    expect(headerCreates()[0][1]).toMatchObject({ Document_Type: 'Order', Sell_to_Customer_No: 'C100', External_Document_No: createMarker(ORDER_ID) })
    expect(docPatches().map((c) => c[3])).toEqual([{ shipToCode: 'WH1' }])
    const hp = headerPatches()
    expect(hp).toHaveLength(1)
    expect(hp[0][3].External_Document_No).toBe('SO1001')
    expect(bc.headers.get('SO1001')!.fields).toMatchObject({ Ship_to_Code: 'WH1', Ship_to_Name: 'WH1 name' })
    expect(lineCreates()).toHaveLength(2)
    expect(lineCreates()[0][1]).toMatchObject({ Document_No: 'SO1001', No: 'ITEM1', Unit_Price: 5 })
    expect(lineCreates()[1][1]).not.toHaveProperty('Unit_Price')
    expect(lineCreates()[0][1]).toHaveProperty('Line_Discount_Percent', 0)

    const o = orderRow()
    expect(o).toMatchObject({
      bc_order_number: 'SO1001', bc_create_marker: createMarker(ORDER_ID), sync_state: 'synced', sync_error: null,
      sync_attempts: 0, synced_version: 3, last_synced_at: '2026-11-13T10:00:00Z', bc_due_date: '2026-12-01',
    })
    // ITEM1 2 x 5 + ITEM2 2 x 9.99 (BC price)
    // totals come from salesDocuments (the fake's line Total_* fields are 0, as on TEST)
    expect(o.total_excl_tax).toBeCloseTo(29.98)
    expect(o.total_incl_tax).toBe(32.98)
    expect(o.total_tax).toBe(3)
    expect(o.bc_etag).toBe(bc.headers.get('SO1001')!.etag)
    expect(lineRow('l1')).toMatchObject({ bc_line_no: 10000, bc_etag: bc.lines.get('SO1001|10000')!.etag, bc_unit_price: 5 })
    expect(lineRow('l2')).toMatchObject({ bc_line_no: 20000, bc_unit_price: 9.99 })
    // the other org's row is untouched
    expect(tables.sales_orders.find((r) => r.organization_id === 'other')).toMatchObject({ bc_order_number: null, sync_state: 'pending' })
  })

  it('uses invoice_number as External_Document_No when set', async () => {
    setup(order({ invoice_number: 'INV-7' }), [line()])
    await syncSalesOrder(deps, ORDER_ID)
    expect(headerPatches()[0][3].External_Document_No).toBe('INV-7')
  })

  it('never sends Customer PO or notes to BC', async () => {
    setup(order(), [line()])
    await syncSalesOrder(deps, ORDER_ID)
    const all = [...bc.t.create.mock.calls.map((c) => c[1]), ...bc.t.patch.mock.calls.map((c) => c[3])]
    expect(all.length).toBeGreaterThan(0)
    for (const body of all) {
      const text = JSON.stringify(body)
      expect(text).not.toContain('PO-SECRET')
      expect(text).not.toContain('NOTE-SECRET')
    }
  })
})

describe('syncSalesOrder: duplicate-safe create', () => {
  it('adopts an order an earlier lost-response create already made, without creating again', async () => {
    const marker = createMarker(ORDER_ID)
    bc.headers.set('SO555', { key: { values: { Document_Type: 'Order', No: 'SO555' } }, etag: bc.etag(), fields: { No: 'SO555', External_Document_No: marker, Sell_to_Customer_No: 'C100' } })
    setup(order({ bc_create_marker: marker }), [line()])

    const state = await syncSalesOrder(deps, ORDER_ID)

    expect(state).toBe('synced')
    expect(bc.t.list.mock.calls[0][1]).toEqual({ filter: `Document_Type eq 'Order' and External_Document_No eq '${marker}'` })
    expect(headerCreates()).toHaveLength(0)
    expect(orderRow().bc_order_number).toBe('SO555')
    expect(lineCreates()[0][1]).toMatchObject({ Document_No: 'SO555' })
  })

  it('saves the marker before creating, and keeps the number if a later step fails', async () => {
    setup(order(), [line()])
    bc.hooks.before = (method, s) => {
      if (method === 'create') expect(orderRow().bc_create_marker).toBe(createMarker(ORDER_ID))
      if (method === 'patch' && !isLineSource(s)) throw new BcReferenceError(500, 'BC is down')
    }
    const state = await syncSalesOrder(deps, ORDER_ID)
    expect(state).toBe('failed')
    expect(orderRow()).toMatchObject({ bc_order_number: 'SO1001', sync_error: 'BC is down', sync_attempts: 1 })

    // retry continues on the same BC order
    bc.hooks.before = undefined
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    expect(headerCreates()).toHaveLength(1)
  })
})

describe('syncSalesOrder: version race', () => {
  it('ends pending with synced_version = the starting version when the order is edited mid-sync', async () => {
    setup(order({ local_version: 3 }), [line()])
    bc.hooks.before = (method, s) => {
      if (method === 'create' && isLineSource(s)) orderRow().local_version = 4
    }
    const state = await syncSalesOrder(deps, ORDER_ID)
    expect(state).toBe('pending')
    expect(orderRow()).toMatchObject({ sync_state: 'pending', synced_version: 3, local_version: 4, sync_error: null })
  })
})

describe('syncSalesOrder: partial failure', () => {
  it('keeps the lines already created and a re-run creates only the rest', async () => {
    setup(order({ sync_attempts: 2 }), [line({ id: 'l1', position: 1 }), line({ id: 'l2', position: 2, item_number: '10031' })])
    bc.hooks.before = (method, s, arg) => {
      if (method === 'create' && isLineSource(s) && (arg as Row).No === '10031') {
        throw new BcReferenceError(400, 'Item 10031 is blocked')
      }
    }
    const state = await syncSalesOrder(deps, ORDER_ID)
    expect(state).toBe('failed')
    expect(orderRow().sync_state).toBe('failed')
    expect(orderRow().sync_error).toContain('Item 10031 is blocked')
    expect(orderRow().sync_attempts).toBe(3)
    expect(lineRow('l1')).toMatchObject({ bc_line_no: 10000 })
    expect(lineRow('l2')).toMatchObject({ bc_line_no: null })

    bc.hooks.before = undefined
    bc.t.create.mockClear()
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    expect(headerCreates()).toHaveLength(0)
    expect(lineCreates()).toHaveLength(1)
    expect(lineCreates()[0][1]).toMatchObject({ No: '10031' })
    expect(lineRow('l2')).toMatchObject({ bc_line_no: 20000 })
    expect(orderRow().sync_attempts).toBe(0)
  })
})

describe('syncSalesOrder: existing order', () => {
  it('marks conflict and sends no patch when BC changed the header', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }])
    bc.headers.get('SO900')!.fields.Payment_Terms_Code = 'NET60'
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag, bc_snapshot: { Payment_Terms_Code: 'NET30' }, bc_create_marker: createMarker(ORDER_ID) }), rows)

    const state = await syncSalesOrder(deps, ORDER_ID)

    expect(state).toBe('conflict')
    expect(orderRow()).toMatchObject({ sync_state: 'conflict', sync_error: 'Changed in BC' })
    expect(bc.t.patch).not.toHaveBeenCalled()
    expect(bc.t.create).not.toHaveBeenCalled()
    expect(bc.t.remove).not.toHaveBeenCalled()
  })

  it('overwrite patches with fresh etags and removes a BC-only line', async () => {
    const { rows } = seedSynced([{ id: 'l1', no: 10000 }, { id: 'bc-only', no: 20000, item: 'EXTRA' }])
    setup(
      order({ bc_order_number: 'SO900', bc_etag: 'W/"stale"', sync_state: 'conflict', sync_error: 'Changed in BC' }),
      [{ ...rows[0], quantity: 7 }],
    )
    const fresh = bc.headers.get('SO900')!.etag

    const state = await syncSalesOrder(deps, ORDER_ID, { overwrite: true })

    expect(state).toBe('synced')
    expect(headerPatches()[0][2]).toBe(fresh)
    expect(bc.lines.has('SO900|20000')).toBe(false)
    expect(bc.t.remove).toHaveBeenCalledTimes(1)
    // the known line differs (quantity) so it is patched with only the changed field
    const lp = bc.t.patch.mock.calls.filter(([s]) => isLineSource(s))
    expect(lp).toHaveLength(1)
    expect(lp[0][3]).toEqual({ Quantity: 7 })
    expect(orderRow()).toMatchObject({ sync_state: 'synced', sync_error: null })
  })

  it('does not patch an unchanged line', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }])
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag }), rows)
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    expect(bc.t.patch.mock.calls.filter(([s]) => isLineSource(s))).toHaveLength(0)
    // BC already has ship-to WH1, so only the header patch is sent
    expect(headerPatches()).toHaveLength(1)
  })

  it('a null discount is not patched over BC’s price-list discount', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }])
    bc.lines.get('SO900|10000')!.fields.Line_Discount_Percent = 12
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag }), rows.map((r) => ({ ...r, discount_percent: null })))
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    expect(bc.t.patch.mock.calls.filter(([s]) => isLineSource(s))).toHaveLength(0)
    expect(lineRow('l1')).toMatchObject({ discount_percent: null, bc_line_discount_percent: 12 })
  })

  it('a typed discount is patched to BC', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }])
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag }), rows.map((r) => ({ ...r, discount_percent: 5 })))
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    const lp = bc.t.patch.mock.calls.filter(([s]) => isLineSource(s))
    expect(lp).toHaveLength(1)
    expect(lp[0][3]).toEqual({ Line_Discount_Percent: 5 })
    expect(lineRow('l1')).toMatchObject({ bc_line_discount_percent: 5 })
  })

  it('removes a removed line in BC, then deletes the local row', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }, { id: 'l2', no: 20000 }])
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag }), [rows[0], { ...rows[1], removed: true }])
    bc.hooks.before = (method, s, key) => {
      if (method === 'remove' && isLineSource(s)) {
        expect((key as { values: Row }).values.Line_No).toBe('20000')
        expect(lineRow('l2')).toBeDefined()
      }
    }

    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    expect(bc.t.remove).toHaveBeenCalledTimes(1)
    expect(bc.lines.has('SO900|20000')).toBe(false)
    expect(lineRow('l2')).toBeUndefined()
    expect(lineRow('l1')).toBeDefined()
  })
})

describe('syncSalesOrder: review fixes', () => {
  it('sends line keys through a source that marks Line_No as an integer key', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }])
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag }), [{ ...rows[0], quantity: 9 }])
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    const lp = bc.t.patch.mock.calls.filter(([s]) => isLineSource(s))
    expect(lp).toHaveLength(1)
    expect(lp[0][0]).toMatchObject({ integerKeyFields: ['Line_No'] })
  })

  it('stores the header etag after each line insert, so a retry after a failure is not a conflict', async () => {
    setup(order(), [line({ id: 'l1', position: 1 }), line({ id: 'l2', position: 2, item_number: 'BAD' })])
    bc.hooks.before = (method, s, arg) => {
      if (method === 'create' && isLineSource(s) && (arg as Row).No === 'BAD') throw new BcReferenceError(400, 'blocked')
    }
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('failed')
    expect(orderRow().bc_etag).toBe(bc.headers.get('SO1001')!.etag)
  })

  it('a removed row whose BC line is already gone is deleted locally, not a conflict', async () => {
    const { rows } = seedSynced([{ id: 'l1', no: 10000 }, { id: 'l2', no: 20000 }])
    bc.lines.delete('SO900|20000')
    setup(order({ bc_order_number: 'SO900', bc_etag: bc.headers.get('SO900')!.etag }), [rows[0], { ...rows[1], removed: true }])
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    expect(bc.t.remove).not.toHaveBeenCalled()
    expect(lineRow('l2')).toBeUndefined()
  })

  it('a remove that 404s while the line is still in BC fails the sync and keeps the row', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }, { id: 'l2', no: 20000 }])
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag }), [rows[0], { ...rows[1], removed: true }])
    bc.hooks.before = (method, s) => {
      if (method === 'remove' && isLineSource(s)) throw new BcReferenceError(404, 'odd 404')
    }
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('failed')
    expect(orderRow().sync_error).toBe('odd 404')
    expect(lineRow('l2')).toBeDefined()
  })

  it('a remove that 404s and the re-list confirms the line is gone counts as removed', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }, { id: 'l2', no: 20000 }])
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag }), [rows[0], { ...rows[1], removed: true }])
    bc.hooks.before = (method, s) => {
      if (method === 'remove' && isLineSource(s)) {
        bc.lines.delete('SO900|20000')
        throw new BcReferenceError(404, 'gone')
      }
    }
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    expect(lineRow('l2')).toBeUndefined()
  })

  it('overwrite recreates a local line whose BC line is missing', async () => {
    const { rows } = seedSynced([{ id: 'l1', no: 10000 }])
    bc.lines.delete('SO900|10000')
    setup(order({ bc_order_number: 'SO900', bc_etag: 'W/"stale"', sync_state: 'conflict' }), rows)
    expect(await syncSalesOrder(deps, ORDER_ID, { overwrite: true })).toBe('synced')
    expect(lineCreates()).toHaveLength(1)
    expect(lineRow('l1')!.bc_line_no).toBe(10000)
    expect(bc.lines.has('SO900|10000')).toBe(true)
  })

  it('with a null bc_etag, a BC line unknown to Nexus is still a conflict', async () => {
    seedSynced([{ id: 'x', no: 10000 }])
    setup(order({ bc_order_number: 'SO900', bc_etag: null }), [line()])
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('conflict')
    expect(bc.t.patch).not.toHaveBeenCalled()
  })

  it('with a null bc_etag and no BC lines, the sync continues', async () => {
    seedSynced([])
    setup(order({ bc_order_number: 'SO900', bc_etag: null }), [line()])
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
  })

  it('refuses to adopt when several BC orders carry the marker', async () => {
    const marker = createMarker(ORDER_ID)
    for (const no of ['SO1', 'SO2']) {
      bc.headers.set(no, { key: { values: { Document_Type: 'Order', No: no } }, etag: bc.etag(), fields: { No: no, External_Document_No: marker } })
    }
    setup(order({ bc_create_marker: marker }), [line()])
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('failed')
    expect(orderRow().sync_error).toBe(`Found 2 BC orders with marker ${marker}; resolve in BC`)
    expect(orderRow().bc_order_number).toBeNull()
    expect(bc.t.create).not.toHaveBeenCalled()
  })

  it('falls back to "BC error" when BC sends no message', async () => {
    setup(order(), [line()])
    bc.hooks.before = (method) => {
      if (method === 'create') throw new BcReferenceError(500, '')
    }
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('failed')
    expect(orderRow().sync_error).toBe('BC error')
  })
})

describe('syncSalesOrder: final review fixes', () => {
  // C1
  it('switches the BC customer first when the order customer changed, then overwrites BC refilled defaults', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }])
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag, customer_number: 'C200' }), rows)

    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')

    const hp = headerPatches()
    expect(hp[0][3]).toEqual({ Sell_to_Customer_No: 'C200' })
    expect(hp[0][2]).toBe(hEtag)
    // BC cleared Ship_to_Code on the switch, so it is sent again (through salesDocuments)
    expect(docPatches().map((c) => c[3])).toEqual([{ shipToCode: 'WH1' }])
    // the header patch uses the etag read back after the salesDocuments patch
    expect(bc.t.patch.mock.calls.map(([src]) => (isDocSource(src) ? 'doc' : isLineSource(src) ? 'line' : 'header')).slice(0, 3)).toEqual(['header', 'doc', 'header'])
    const h = bc.headers.get('SO900')!.fields
    expect(h).toMatchObject({ Sell_to_Customer_No: 'C200', Ship_to_Code: 'WH1', Payment_Terms_Code: 'NET30', Location_Code: 'MAIN', Tax_Area_Code: 'TX' })
    // lines kept
    expect(bc.t.create).not.toHaveBeenCalled()
    expect(bc.t.remove).not.toHaveBeenCalled()
    expect(bc.lines.has('SO900|10000')).toBe(true)
  })

  it('switches the customer on the overwrite path too', async () => {
    const { rows } = seedSynced([{ id: 'l1', no: 10000 }])
    setup(order({ bc_order_number: 'SO900', bc_etag: 'W/"stale"', sync_state: 'conflict', customer_number: 'C200' }), rows)
    expect(await syncSalesOrder(deps, ORDER_ID, { overwrite: true })).toBe('synced')
    expect(headerPatches()[0][3]).toEqual({ Sell_to_Customer_No: 'C200' })
    expect(bc.headers.get('SO900')!.fields.Sell_to_Customer_No).toBe('C200')
  })

  it('does not patch the customer when it is unchanged', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }])
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag }), rows)
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    expect(headerPatches().some(([, , , f]) => 'Sell_to_Customer_No' in f)).toBe(false)
  })

  it('a failure right after our customer switch is not read as a BC change on retry', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }])
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag, customer_number: 'C200' }), rows)
    bc.hooks.before = (method, s) => {
      if (method === 'patch' && isDocSource(s)) throw new BcReferenceError(500, 'BC is down')
    }
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('failed')
    bc.hooks.before = undefined
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    expect(bc.headers.get('SO900')!.fields).toMatchObject({ Sell_to_Customer_No: 'C200', Ship_to_Code: 'WH1' })
  })

  // I3
  it('sends no Ship_to_Code when BC already has the same one', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }])
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag }), rows)
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    expect(docPatches()).toHaveLength(0)
  })

  it('a ship-to deleted since the order was saved is sent as blank, keeping the copied address', async () => {
    const { rows } = seedSynced([{ id: 'l1', no: 10000 }])
    bc.headers.set('SO900', { ...bc.headers.get('SO900')!, fields: { ...bc.headers.get('SO900')!.fields, Ship_to_Code: 'GONE' } })
    const hEtag = bc.headers.get('SO900')!.etag
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag, ship_to_code: 'GONE', ship_to_address: 'copied st' }), rows)
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    const dp = docPatches().map(([, , , f]) => f)
    expect(dp[0]).toEqual({ shipToCode: '' })
    expect(dp[1]).toMatchObject({ shipToAddress: 'copied st' })
    expect(bc.headers.get('SO900')!.fields).toMatchObject({ Ship_to_Code: '', Ship_to_Address: 'copied st' })
  })

  it('a deleted ship-to with BC already blank sends no Ship_to_Code (same code in another org does not count)', async () => {
    const { rows } = seedSynced([{ id: 'l1', no: 10000 }])
    bc.headers.set('SO900', { ...bc.headers.get('SO900')!, fields: { ...bc.headers.get('SO900')!.fields, Ship_to_Code: '' } })
    setup(order({ bc_order_number: 'SO900', bc_etag: bc.headers.get('SO900')!.etag, ship_to_code: 'GONE' }), rows)
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    expect(docPatches().some(([, , , f]) => 'shipToCode' in f)).toBe(false)
  })

  // I2
  it('writes updated_at on every result write', async () => {
    setup(order(), [line()])
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    expect(orderRow().updated_at).toBe('2026-11-13T10:00:00Z')

    setup(order({ local_version: 3 }), [line()])
    bc.hooks.before = (method, s) => {
      if (method === 'create' && isLineSource(s)) orderRow().local_version = 4
    }
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('pending')
    expect(orderRow().updated_at).toBe('2026-11-13T10:00:00Z')

    bc.hooks.before = undefined
    const { rows } = seedSynced([{ id: 'l1', no: 10000 }])
    setup(order({ bc_order_number: 'SO900', bc_etag: 'W/"stale"', bc_snapshot: { Payment_Terms_Code: 'OLD' } }), rows)
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('conflict')
    expect(orderRow().updated_at).toBe('2026-11-13T10:00:00Z')

    setup(order(), [line()])
    bc.hooks.before = () => { throw new BcReferenceError(500, 'down') }
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('failed')
    expect(orderRow().updated_at).toBe('2026-11-13T10:00:00Z')
  })

  // I4
  it('removes a just-created BC line whose local row was deleted meanwhile, and refreshes the header etag', async () => {
    setup(order(), [line({ id: 'l1', position: 1 }), line({ id: 'l2', position: 2, item_number: 'ITEM2' })])
    bc.hooks.before = (method, s, arg) => {
      if (method === 'create' && isLineSource(s) && (arg as Row).No === 'ITEM2') {
        tables.sales_order_lines = tables.sales_order_lines.filter((r) => r.id !== 'l2')
      }
    }
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    expect(lineCreates()).toHaveLength(2)
    expect(bc.t.remove).toHaveBeenCalledTimes(1)
    expect(bc.t.remove.mock.calls[0][1]).toMatchObject({ values: { Line_No: '20000' } })
    expect([...bc.lines.keys()]).toEqual(['SO1001|10000'])
    expect(orderRow().bc_etag).toBe(bc.headers.get('SO1001')!.etag)
  })

  // I6
  it('re-lists the lines after the header patches, so line patches use post-header etags', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }])
    const before = bc.lines.get('SO900|10000')!.etag
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag }), [{ ...rows[0], quantity: 9 }])
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    const lp = bc.t.patch.mock.calls.filter(([s]) => isLineSource(s))
    expect(lp).toHaveLength(1)
    expect(lp[0][2]).not.toBe(before)
    expect(bc.lines.get('SO900|10000')!.fields.Quantity).toBe(9)
  })

  it('a line failure after the header patch is not a conflict on retry (line etags stored after the re-list)', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }, { id: 'l2', no: 20000 }])
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag }), [rows[0], { ...rows[1], quantity: 9 }])
    bc.hooks.before = (method, s) => {
      if (method === 'patch' && isLineSource(s)) throw new BcReferenceError(400, 'line refused')
    }
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('failed')
    bc.hooks.before = undefined
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
  })
})

describe('syncSalesOrder: conflict check by managed-field values', () => {
  it('a BC background re-save (header etag changed, values equal) is not a conflict', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }])
    const h = bc.headers.get('SO900')!
    const snap = snapshotOf(h, HEADER_SNAPSHOT_FIELDS)
    // BC re-saves the header: new etag, same values
    bc.headers.set('SO900', { ...h, etag: bc.etag() })
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag, bc_snapshot: snap }), rows)

    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    expect(headerPatches().length).toBeGreaterThan(0)
  })

  it('a managed header field changed in BC is a conflict, with no BC write', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }])
    const h = bc.headers.get('SO900')!
    const snap = snapshotOf(h, HEADER_SNAPSHOT_FIELDS)
    bc.headers.set('SO900', { ...h, etag: bc.etag(), fields: { ...h.fields, Ship_to_Code: 'DOCK' } })
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag, bc_snapshot: snap }), rows)

    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('conflict')
    expect(orderRow()).toMatchObject({ sync_state: 'conflict', sync_error: 'Changed in BC' })
    expect(bc.t.patch).not.toHaveBeenCalled()
    expect(bc.t.create).not.toHaveBeenCalled()
    expect(bc.t.remove).not.toHaveBeenCalled()
  })

  it('a retry after the header patch succeeded and a line create failed is not a conflict', async () => {
    setup(order(), [line({ id: 'l1', position: 1 }), line({ id: 'l2', position: 2, item_number: 'BAD' })])
    bc.hooks.before = (method, s, arg) => {
      if (method === 'create' && isLineSource(s) && (arg as Row).No === 'BAD') throw new BcReferenceError(400, 'blocked')
    }
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('failed')
    expect(headerPatches()).toHaveLength(1)
    bc.hooks.before = undefined
    // and BC re-saves the patched header in the background meanwhile
    const h = bc.headers.get('SO1001')!
    bc.headers.set('SO1001', { ...h, etag: bc.etag() })

    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
  })

  it('stores the BC snapshot on the order and on each line after a sync', async () => {
    setup(order(), [line({ id: 'l1', position: 1 })])
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    expect(orderRow().bc_snapshot).toEqual(snapshotOf(bc.headers.get('SO1001')!, HEADER_SNAPSHOT_FIELDS))
    expect(orderRow().bc_snapshot).toMatchObject({ Sell_to_Customer_No: 'C100', Ship_to_Code: 'WH1', Payment_Terms_Code: 'NET30', Tax_Liable: true })
    expect(lineRow('l1')!.bc_snapshot).toEqual({
      Type: 'Item', No: 'ITEM1', Quantity: 2, Unit_of_Measure_Code: 'PCS', Unit_Price: 5, Line_Discount_Percent: 0, Location_Code: 'MAIN',
    })
  })
})

describe('syncSalesOrder: unfinished save marker (R13)', () => {
  it('returns failed with no BC call and no DB write for an order whose save did not finish', async () => {
    setup(order({ sync_state: 'failed', sync_error: 'Save did not finish: disk full', sync_attempts: 2 }), [line()])
    const before = JSON.stringify(tables)
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('failed')
    for (const fn of [bc.t.list, bc.t.get, bc.t.create, bc.t.patch, bc.t.remove]) expect(fn).not.toHaveBeenCalled()
    expect(JSON.stringify(tables)).toBe(before)
  })

  it('skips only when not overwriting', async () => {
    setup(order({ sync_state: 'failed', sync_error: 'Save did not finish: disk full' }), [line()])
    expect(await syncSalesOrder(deps, ORDER_ID, { overwrite: true })).toBe('synced')
  })

  it('a failed order with another error still syncs', async () => {
    setup(order({ sync_state: 'failed', sync_error: 'BC is down' }), [line()])
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
  })
})

describe('syncSalesOrder: ship-to through salesDocuments (R14)', () => {
  const docLookups = () => bc.t.list.mock.calls.filter(([src]) => isDocSource(src)).map(([, o]) => o)
  const oneOff = { ship_to_code: '', ship_to_name: 'Pop-up', ship_to_address: '9 Beach Rd', ship_to_address_2: 'Unit 2', ship_to_city: 'Hilo', ship_to_state: 'HI', ship_to_post_code: '96720', ship_to_country: 'US', ship_to_contact: 'Kai', ship_to_phone: '555' }

  it('never writes a Ship_to_* field through the SalesOrder page', async () => {
    setup(order(), [line()])
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    for (const [, , , f] of headerPatches()) expect(Object.keys(f).filter((k) => k.startsWith('Ship_to_'))).toEqual([])
  })

  it('saved code: looks up the salesDocuments row by order number and patches only shipToCode; BC fills the address', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }])
    bc.shipTos.add('C100|DOCK')
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag, ship_to_code: 'DOCK' }), rows)
    tables.customer_ship_to_addresses.push({ organization_id: 'org', bc_connection_id: 'conn', customer_number: 'C100', code: 'DOCK' })
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    expect(docLookups()).toEqual([{ filter: "documentType eq 'Order' and number eq 'SO900'" }])
    expect(docPatches().map((c) => c[3])).toEqual([{ shipToCode: 'DOCK' }])
    expect(bc.headers.get('SO900')!.fields).toMatchObject({ Ship_to_Code: 'DOCK', Ship_to_Address: 'DOCK st' })
  })

  it('one-off: clears the code, then patches only the address fields that differ', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }])
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag, ...oneOff, ship_to_city: 'cust city' }), rows)
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    const dp = docPatches().map((c) => c[3])
    expect(dp[0]).toEqual({ shipToCode: '' })
    // BC filled the customer's address on the clear; city already matches, so it is not sent
    expect(dp[1]).toEqual({
      shipToName: 'Pop-up', shipToAddress: '9 Beach Rd', shipToAddress2: 'Unit 2', shipToCounty: 'HI',
      shipToPostCode: '96720', shipToCountryRegionCode: 'US', shipToContact: 'Kai', shipToPhoneNo: '555',
    })
    expect(dp).toHaveLength(2)
    expect(bc.headers.get('SO900')!.fields).toMatchObject({ Ship_to_Code: '', Ship_to_Name: 'Pop-up', Ship_to_Address: '9 Beach Rd', Ship_to_City: 'cust city' })
  })

  it('billing copy (no code, address = billing) goes the same way and lands in BC', async () => {
    setup(order({ ship_to_code: '', ship_to_name: 'Bill', ship_to_address: 'a1', ship_to_city: 'bc', ship_to_state: 'bs', ship_to_post_code: 'bp' }), [line()])
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    // a new order already has a blank code, so only the address is patched
    const dp = docPatches().map((c) => c[3])
    expect(dp).toHaveLength(1)
    expect(dp[0]).not.toHaveProperty('shipToCode')
    expect(bc.headers.get('SO1001')!.fields).toMatchObject({ Ship_to_Code: '', Ship_to_Name: 'Bill', Ship_to_Address: 'a1', Ship_to_City: 'bc', Ship_to_County: 'bs' })
  })

  it('no salesDocuments patch when the code is blank and BC already has the same address', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }])
    const h = bc.headers.get('SO900')!
    bc.headers.set('SO900', { ...h, fields: { ...h.fields, Ship_to_Code: '', Ship_to_Name: 'sn', Ship_to_Address: 'sa', Ship_to_Address_2: '', Ship_to_City: 'sc', Ship_to_County: 'ss', Ship_to_Post_Code: 'sp', Ship_to_Country_Region_Code: 'US', Ship_to_Contact: '', Ship_to_Phone_No: '' } })
    void hEtag
    setup(order({ bc_order_number: 'SO900', bc_etag: h.etag, ship_to_code: '' }), rows)
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    expect(docPatches()).toHaveLength(0)
  })

  it('stores the SalesOrder etag read after the salesDocuments patch before the header patch', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }])
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag, ...oneOff }), rows)
    bc.hooks.before = (method, src) => {
      if (method === 'patch' && !isDocSource(src) && !isLineSource(src)) {
        expect(orderRow().bc_etag).toBe(bc.headers.get('SO900')!.etag)
        throw new BcReferenceError(500, 'header down')
      }
    }
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('failed')
    bc.hooks.before = undefined
    // retry is not a conflict: the etag after our salesDocuments write was stored
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
  })

  it('customer switch: Sell_to_Customer_No on SalesOrder, then the code on salesDocuments, then the header', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }])
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag, customer_number: 'C200', ...oneOff }), rows)
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    const order3 = bc.t.patch.mock.calls.map(([src, , , f]) => (isDocSource(src) ? 'doc' : isLineSource(src) ? 'line' : 'header:' + Object.keys(f)[0]))
    expect(order3.slice(0, 3)).toEqual(['header:Sell_to_Customer_No', 'doc', 'header:Order_Date'])
    expect(bc.headers.get('SO900')!.fields).toMatchObject({ Sell_to_Customer_No: 'C200', Ship_to_Name: 'Pop-up', Tax_Area_Code: 'TX', Location_Code: 'MAIN' })
  })

  it('R16: totals are read from salesDocuments re-read after all writes, not a pre-write copy', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }])
    // the line quantity changes in this sync, so a pre-write copy would carry the old totals
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag, ship_to_code: '' }), [{ ...rows[0], quantity: 4 }])
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    expect(orderRow()).toMatchObject({ total_excl_tax: 20, total_incl_tax: 22, total_tax: 2 })
    const docGets = bc.t.get.mock.calls.filter(([src]) => isDocSource(src))
    expect(docGets).toHaveLength(1)
    // the GET came after the last line write
    const lastLineWrite = Math.max(...bc.t.patch.mock.invocationCallOrder.filter((_, i) => isLineSource(bc.t.patch.mock.calls[i][0])))
    expect(bc.t.get.mock.invocationCallOrder[bc.t.get.mock.calls.findIndex(([src]) => isDocSource(src))]).toBeGreaterThan(lastLineWrite)
  })

  it('R17: each salesDocuments write stores the new SalesOrder etag, so a failed later ship-to write is not a conflict on retry', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }])
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag, ship_to_code: '', ship_to_name: 'Pop-up', ship_to_address: '9 Beach Rd' }), rows)
    bc.hooks.before = (method, src, arg) => {
      if (method === 'patch' && isDocSource(src) && !('shipToCode' in (arg as Row))) throw new BcReferenceError(500, 'address down')
    }
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('failed')
    expect(docPatches()[0][3]).toEqual({ shipToCode: '' })
    expect(orderRow().bc_etag).toBe(bc.headers.get('SO900')!.etag)
    bc.hooks.before = undefined
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('synced')
    expect(bc.headers.get('SO900')!.fields).toMatchObject({ Ship_to_Code: '', Ship_to_Name: 'Pop-up', Ship_to_Address: '9 Beach Rd' })
  })

  it('R17: a salesDocuments row without an id fails clearly at lookup', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }])
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag }), rows)
    bc.t.list.mockImplementation(async (src: ReferenceSource) => {
      if (isDocSource(src)) return [{ key: { values: {} }, etag: 'D', fields: { number: 'SO900', shipToCode: 'WH1' } }]
      return [...bc.lines.values()].filter((l) => l.fields.Document_No === 'SO900')
    })
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('failed')
    expect(orderRow().sync_error).toBe('BC sales document for order SO900 not found')
    expect(docPatches()).toHaveLength(0)
  })

  it('fails clearly when BC has no salesDocuments row for the order', async () => {
    const { hEtag, rows } = seedSynced([{ id: 'l1', no: 10000 }])
    setup(order({ bc_order_number: 'SO900', bc_etag: hEtag, ship_to_code: '' }), rows)
    bc.t.list.mockImplementation(async (src: ReferenceSource) => {
      if (isDocSource(src)) return []
      return [...bc.lines.values()].filter((l) => l.fields.Document_No === 'SO900')
    })
    expect(await syncSalesOrder(deps, ORDER_ID)).toBe('failed')
    expect(orderRow().sync_error).toBe('BC sales document for order SO900 not found')
  })
})

describe('deleteSalesOrderInBc', () => {
  it('removes the BC order with a fresh etag', async () => {
    seedSynced([])
    setup(order({ bc_order_number: 'SO900', bc_etag: 'W/"stale"' }), [])
    await deleteSalesOrderInBc(deps, order({ bc_order_number: 'SO900' }))
    expect(bc.headers.has('SO900')).toBe(false)
  })

  it('treats a 404 as already gone', async () => {
    setup(order({ bc_order_number: 'SO404' }), [])
    await expect(deleteSalesOrderInBc(deps, order({ bc_order_number: 'SO404' }))).resolves.toBeUndefined()
  })

  it('does nothing when the order was never sent', async () => {
    setup(order(), [])
    await deleteSalesOrderInBc(deps, order())
    expect(bc.t.get).not.toHaveBeenCalled()
    expect(bc.t.remove).not.toHaveBeenCalled()
  })

  it('refuses an order from another organization', async () => {
    setup(order(), [])
    await expect(deleteSalesOrderInBc(deps, order({ organization_id: 'other', bc_order_number: 'SO900' }))).rejects.toThrow()
    expect(bc.t.remove).not.toHaveBeenCalled()
  })
})
