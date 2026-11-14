'use client';

import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import {
  deleteSalesOrder,
  overwriteBcWithNexus,
  retrySalesOrderSync,
  saveSalesOrder,
  setSalesOrderStatus,
  type SalesOrderFormContext,
} from '@/app/actions/salesOrders';
import { refreshShipTos, saveShipToAction } from '@/app/actions/shipToAddresses';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { applyShipTo, customerDefaults } from '@/lib/salesOrders/orderDefaults';
import { canDelete, editableFields } from '@/lib/salesOrders/orderRules';
import type {
  CustomerRow,
  LineDraft,
  OrderHeaderDefaults,
  OrderStatus,
  SalesOrderInput,
  SalesOrderLineRow,
  SalesOrderRow,
  ShipToRow,
} from '@/types/salesOrders';
import { CustomerPicker, customerLabel } from './CustomerPicker';
import { SalesOrderLinesTable } from './SalesOrderLinesTable';
import { ShipToPicker, type ShipToAddressFields, type ShipToChoice } from './ShipToPicker';
import { StatusSelect } from './StatusSelect';
import { SyncBadge } from './SyncBadge';

interface Props {
  /** null = a new order. */
  order: SalesOrderRow | null;
  lines: SalesOrderLineRow[];
  context: SalesOrderFormContext;
  /** The order customer's saved ship-tos (empty for a new order). */
  shipTos: ShipToRow[];
  canEdit: boolean;
  /** "Save to customer" on a one-off ship-to needs customer edit permission. */
  canSaveShipTo: boolean;
}

type Option = { code: string; label: string };

const NOT_SENT = 'Calculated when sent to BC';
const POLL_MS = 4000;
const MAX_POLLS = 15;

const LABEL = 'text-[11px] uppercase tracking-wide text-foreground-subtle';
const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60';

const HEADER_KEYS: (keyof OrderHeaderDefaults)[] = [
  'bill_name', 'bill_address', 'bill_address_2', 'bill_city', 'bill_state', 'bill_post_code', 'bill_country',
  'bill_contact_no', 'bill_phone', 'bill_mobile', 'bill_email', 'bill_email_cc', 'ship_to_code', 'ship_to_name',
  'ship_to_address', 'ship_to_address_2', 'ship_to_city', 'ship_to_state', 'ship_to_post_code', 'ship_to_country',
  'ship_to_contact', 'ship_to_phone', 'payment_terms_code', 'tax_area_code', 'gen_bus_posting_group',
  'customer_posting_group', 'shipment_method_code', 'location_code', 'tax_liable',
];

const EMPTY_HEADER = Object.fromEntries(
  HEADER_KEYS.map((k) => [k, k === 'tax_liable' ? false : '']),
) as unknown as OrderHeaderDefaults;

const BILLING_FIELDS: { key: keyof OrderHeaderDefaults; label: string; maxLength: number; type?: string }[] = [
  { key: 'bill_address', label: 'Address', maxLength: 100 },
  { key: 'bill_address_2', label: 'Address 2', maxLength: 50 },
  { key: 'bill_city', label: 'City', maxLength: 30 },
  { key: 'bill_state', label: 'State', maxLength: 30 },
  { key: 'bill_post_code', label: 'ZIP code', maxLength: 20 },
  { key: 'bill_country', label: 'Country/Region', maxLength: 10 },
  { key: 'bill_contact_no', label: 'Contact no.', maxLength: 20 },
  { key: 'bill_phone', label: 'Phone no.', maxLength: 30, type: 'tel' },
  { key: 'bill_mobile', label: 'Mobile phone no.', maxLength: 30, type: 'tel' },
  { key: 'bill_email', label: 'Email', maxLength: 80, type: 'email' },
  { key: 'bill_email_cc', label: 'Email CC', maxLength: 80 },
];

type TermKey = 'payment_terms_code' | 'shipment_method_code' | 'tax_area_code' | 'gen_bus_posting_group' | 'customer_posting_group';
const TERM_FIELDS: { key: TermKey; label: string; list: string }[] = [
  { key: 'payment_terms_code', label: 'Payment terms', list: 'paymentTerms' },
  { key: 'shipment_method_code', label: 'Shipment method', list: 'shipmentMethods' },
  { key: 'tax_area_code', label: 'Tax area', list: 'taxAreas' },
  { key: 'gen_bus_posting_group', label: 'Gen. bus. posting group', list: 'generalBusinessPostingGroups' },
  { key: 'customer_posting_group', label: 'Customer posting group', list: 'customerPostingGroups' },
];

const SHIP_ADDRESS_KEYS: (keyof ShipToAddressFields)[] = [
  'ship_to_name', 'ship_to_address', 'ship_to_address_2', 'ship_to_city', 'ship_to_state', 'ship_to_post_code',
  'ship_to_country', 'ship_to_contact', 'ship_to_phone',
];

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function headerOf(order: SalesOrderRow): OrderHeaderDefaults {
  return Object.fromEntries(
    HEADER_KEYS.map((k) => [k, k === 'tax_liable' ? Boolean(order[k]) : (order[k] ?? '')]),
  ) as unknown as OrderHeaderDefaults;
}

/** A saved code is a saved ship-to; otherwise it is the billing address unless the address differs. */
function initialChoice(order: SalesOrderRow | null): ShipToChoice {
  if (!order) return { kind: 'billing' };
  if (order.ship_to_code) return { kind: 'saved', code: order.ship_to_code };
  const pairs: [keyof SalesOrderRow, keyof SalesOrderRow][] = [
    ['ship_to_name', 'bill_name'], ['ship_to_address', 'bill_address'], ['ship_to_address_2', 'bill_address_2'],
    ['ship_to_city', 'bill_city'], ['ship_to_state', 'bill_state'], ['ship_to_post_code', 'bill_post_code'],
    ['ship_to_country', 'bill_country'],
  ];
  return pairs.every(([a, b]) => (order[a] ?? '') === (order[b] ?? '')) ? { kind: 'billing' } : { kind: 'oneoff' };
}

function lineDraftOf(row: SalesOrderLineRow, estimates: Map<string, number | null>): LineDraft {
  return {
    key: row.id,
    id: row.id,
    item_number: row.item_number,
    description: row.description ?? '',
    quantity: Number(row.quantity),
    unit_price: num(row.unit_price),
    discount_percent: Number(row.discount_percent ?? 0),
    unit_of_measure_code: row.unit_of_measure_code ?? '',
    amount_incl_tax: num(row.amount_incl_tax),
    estimate_price: estimates.get(row.item_number) ?? null,
    bc_unit_price: num(row.bc_unit_price),
  };
}

/** Stand-in for a customer that is no longer pickable (e.g. blocked), built from the order's own values. */
function customerFromHeader(id: string, number: string, defaultCode: string, h: OrderHeaderDefaults): CustomerRow {
  return {
    id,
    bc_customer_number: number,
    display_name: h.bill_name,
    address_line_1: h.bill_address,
    address_line_2: h.bill_address_2,
    city: h.bill_city,
    state: h.bill_state,
    postal_code: h.bill_post_code,
    country: h.bill_country,
    phone_number: h.bill_phone,
    email: h.bill_email,
    email_cc: h.bill_email_cc,
    contact_no: h.bill_contact_no,
    mobile_phone_no: h.bill_mobile,
    ship_to_code: defaultCode,
    shipment_method_code: h.shipment_method_code,
    payment_terms_code: h.payment_terms_code,
    tax_area_code: h.tax_area_code,
    tax_liable: h.tax_liable,
    customer_posting_group: h.customer_posting_group,
    gen_bus_posting_group: h.gen_bus_posting_group,
    location_code: h.location_code,
  };
}

/** Options with the current value kept even when it isn't in the synced list. */
function withCurrent(options: Option[], current: string): Option[] {
  return !current || options.some((o) => o.code === current) ? options : [{ code: current, label: current }, ...options];
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-surface-raised p-4 card-shadow">
      <h2 className="mb-3 text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

export function SalesOrderForm({ order, lines, context, shipTos: initialShipTos, canEdit, canSaveShipTo }: Props) {
  const router = useRouter();
  const { customers, items, selectOptions, companyLocation, today } = context;
  const initialCustomer = order ? customers.find((c) => c.id === order.customer_id) ?? null : null;

  const [customerId, setCustomerId] = useState(order?.customer_id ?? '');
  const [customerNumber, setCustomerNumber] = useState(order?.customer_number ?? '');
  const [customerName, setCustomerName] = useState(initialCustomer?.display_name ?? order?.bill_name ?? '');
  const [defaultShipCode, setDefaultShipCode] = useState(initialCustomer?.ship_to_code ?? '');
  const [header, setHeader] = useState<OrderHeaderDefaults>(() => (order ? headerOf(order) : EMPTY_HEADER));
  const [shipTos, setShipTos] = useState<ShipToRow[]>(initialShipTos);
  const [shipChoice, setShipChoice] = useState<ShipToChoice>(() => initialChoice(order));
  const [saveToCustomer, setSaveToCustomer] = useState(false);
  const [status, setStatus] = useState<OrderStatus>(order?.status ?? 'draft');
  const [orderDate, setOrderDate] = useState(order?.order_date ?? today);
  const [requestedDate, setRequestedDate] = useState(order?.requested_delivery_date ?? '');
  const [invoiceNumber, setInvoiceNumber] = useState(order?.invoice_number ?? '');
  const [customerPo, setCustomerPo] = useState(order?.customer_po ?? '');
  const [notes, setNotes] = useState(order?.notes ?? '');
  const [draftLines, setDraftLines] = useState<LineDraft[]>(() => {
    const estimates = new Map(items.map((i) => [i.bc_item_number, i.unit_price]));
    return lines.map((l) => lineDraftOf(l, estimates));
  });
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, startTransition] = useTransition();

  // Which customer pick is current, and whether the rep chose a ship-to since; read only in async callbacks.
  const pickToken = useRef(0);
  const shipTouched = useRef(false);

  const syncState = order?.sync_state;
  const orderId = order?.id;
  // The background sync finishes after the save returns; refresh a few times to pick up its result.
  useEffect(() => {
    if (!orderId || syncState !== 'pending') return;
    let polls = 0;
    const timer = setInterval(() => {
      polls += 1;
      router.refresh();
      if (polls >= MAX_POLLS) clearInterval(timer);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [orderId, syncState, router]);

  const locked = !canEdit || (order ? editableFields(order.status) !== 'all' : false);
  const busy = pending;

  const currentCustomer = (): CustomerRow =>
    customers.find((c) => c.id === customerId) ?? customerFromHeader(customerId, customerNumber, defaultShipCode, header);

  // Read-back amounts and BC prices arrive on refresh; show them without discarding the rep's unsaved edits.
  const readBack = new Map(lines.map((l) => [l.id, { amount: num(l.amount_incl_tax), price: num(l.bc_unit_price) }]));
  const shownLines = draftLines.map((l) => {
    const r = l.id ? readBack.get(l.id) : undefined;
    return r ? { ...l, amount_incl_tax: r.amount, bc_unit_price: r.price } : l;
  });

  const setField = <K extends keyof OrderHeaderDefaults>(key: K, value: OrderHeaderDefaults[K]) =>
    setHeader((h) => ({ ...h, [key]: value }));

  function pickCustomer(c: CustomerRow) {
    const token = ++pickToken.current;
    shipTouched.current = false;
    const number = c.bc_customer_number ?? '';
    setCustomerId(c.id);
    setCustomerNumber(number);
    setCustomerName(c.display_name);
    setDefaultShipCode(c.ship_to_code ?? '');
    setHeader(customerDefaults(c, null, companyLocation));
    setShipChoice({ kind: 'billing' });
    setSaveToCustomer(false);
    setShipTos([]);
    if (!number) return;
    refreshShipTos(number)
      .then((rows) => {
        if (token !== pickToken.current) return;
        setShipTos(rows);
        const def = rows.find((r) => r.code === c.ship_to_code);
        if (def && !shipTouched.current) {
          setHeader((h) => applyShipTo(h, c, def, companyLocation));
          setShipChoice({ kind: 'saved', code: def.code });
        }
      })
      .catch((e: unknown) => {
        // No BC environment selected, or BC unreachable: keep the ship-tos we have.
        console.error('[sales-orders] could not refresh ship-tos:', e);
      });
  }

  function chooseShipTo(choice: ShipToChoice) {
    shipTouched.current = true;
    setShipChoice(choice);
    if (choice.kind === 'oneoff') {
      setHeader((h) => ({ ...h, ship_to_code: '' }));
      return;
    }
    setSaveToCustomer(false);
    const customer = currentCustomer();
    if (choice.kind === 'billing') {
      setHeader((h) => applyShipTo(h, customer, null, companyLocation));
      return;
    }
    const row = shipTos.find((r) => r.code === choice.code);
    if (row) setHeader((h) => applyShipTo(h, customer, row, companyLocation));
  }

  function save() {
    setError(null);
    if (!customerId || !customerNumber) {
      setError('Choose a customer.');
      return;
    }
    startTransition(async () => {
      // Locked order, only the status changed: status is Nexus-only, so skip the save (and its BC sync).
      if (order && locked && notes === order.notes && status !== order.status) {
        const res = await setSalesOrderStatus(order.id, status);
        if (!res.ok) setError(res.error);
        else router.refresh();
        return;
      }
      let h = header;
      if (shipChoice.kind === 'oneoff' && saveToCustomer && canSaveShipTo && !locked) {
        const res = await saveShipToAction({
          customerNumber,
          values: {
            code: '',
            name: h.ship_to_name,
            address: h.ship_to_address,
            address_2: h.ship_to_address_2,
            city: h.ship_to_city,
            state: h.ship_to_state,
            post_code: h.ship_to_post_code,
            country: h.ship_to_country,
            contact: h.ship_to_contact,
            phone: h.ship_to_phone,
            email: '',
            tax_area_code: '',
            location_code: '',
            shipment_method_code: '',
            tax_liable: false,
          },
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        // From here on it is a saved ship-to, so a failed order save can be retried without saving it twice.
        h = { ...h, ship_to_code: res.row.code };
        setHeader(h);
        setShipTos((rows) => [...rows.filter((r) => r.code !== res.row.code), res.row]);
        setShipChoice({ kind: 'saved', code: res.row.code });
        setSaveToCustomer(false);
      }

      const input: SalesOrderInput & { id?: string } = {
        ...h,
        customer_id: customerId,
        customer_number: customerNumber,
        status,
        order_date: orderDate,
        requested_delivery_date: requestedDate || null,
        invoice_number: invoiceNumber.trim() || null,
        customer_po: customerPo,
        notes,
        lines: draftLines,
        ...(order ? { id: order.id } : {}),
      };
      const res = await saveSalesOrder(input);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      if (order) router.refresh();
      else router.push(`/sales-orders/${res.id}`);
    });
  }

  function remove() {
    if (!order) return;
    setError(null);
    startTransition(async () => {
      const res = await deleteSalesOrder(order.id);
      setConfirmDelete(false);
      if (!res.ok) {
        setError(res.error);
        router.refresh();
        return;
      }
      router.push('/sales-orders');
    });
  }

  function runSync(overwrite: boolean) {
    if (!order) return;
    setError(null);
    startTransition(async () => {
      const res = overwrite ? await overwriteBcWithNexus(order.id) : await retrySalesOrderSync(order.id);
      if (!res.ok) setError(res.error);
      router.refresh();
    });
  }

  const showTotals = order !== null && order.sync_state !== 'pending';
  const total = (v: number | null | undefined) => {
    const n = num(v);
    return showTotals && n !== null ? money(n) : NOT_SENT;
  };
  const shipAddress = Object.fromEntries(SHIP_ADDRESS_KEYS.map((k) => [k, header[k]])) as ShipToAddressFields;

  return (
    <div className="flex h-[calc(100vh-3.5rem)] min-h-0 flex-col overflow-hidden bg-background">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <nav aria-label="Breadcrumb" className="text-sm text-foreground-muted">
            <Link href="/sales-orders" className="hover:text-foreground">
              Sales Orders
            </Link>
            <span className="mx-1.5">›</span>
          </nav>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {order ? order.bc_order_number || 'Not yet in BC' : 'New sales order'}
          </h1>
        </div>
        <StatusSelect value={status} onChange={setStatus} disabled={!canEdit || busy} />
        {order && (
          <SyncBadge
            state={order.sync_state}
            error={order.sync_error}
            canAct={canEdit}
            busy={busy}
            claimedUntil={order.claimed_until}
            updatedAt={order.updated_at}
            onRetry={() => runSync(false)}
            onOverwrite={() => runSync(true)}
          />
        )}
      </header>

      {error && (
        <div role="alert" className="border-b border-border bg-destructive-subtle px-5 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {order && canEdit && locked && (
        <div className="border-b border-border bg-warning-subtle px-5 py-2 text-sm text-foreground">
          This order is locked. Only Status and Notes can change; set it back to Draft and save to edit the rest.
        </div>
      )}

      <form
        className="min-h-0 flex-1 overflow-y-auto p-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="mx-auto max-w-6xl space-y-4">
          <Section title="Order">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="so-customer" className={LABEL}>Customer</Label>
                <CustomerPicker
                  customers={customers}
                  selectedLabel={customerLabel(customerNumber, customerName)}
                  disabled={locked || busy}
                  onPick={pickCustomer}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="so-invoice" className={LABEL}>Invoice # (Ext. Doc No.)</Label>
                <Input
                  id="so-invoice"
                  value={invoiceNumber}
                  maxLength={35}
                  placeholder="Same as order number"
                  disabled={locked || busy}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="so-customer-po" className={LABEL}>Customer PO</Label>
                <Input
                  id="so-customer-po"
                  value={customerPo}
                  maxLength={100}
                  aria-describedby="so-customer-po-help"
                  disabled={locked || busy}
                  onChange={(e) => setCustomerPo(e.target.value)}
                />
                <p id="so-customer-po-help" className="text-xs text-foreground-subtle">
                  Nexus and Bill.com only, not sent to BC
                </p>
              </div>
            </div>
          </Section>

          <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
            <section className="rounded-xl border border-border bg-surface-raised p-4 card-shadow">
              <fieldset disabled={locked || busy} className="min-w-0">
                <legend className="mb-3 text-sm font-semibold text-foreground">Billing address</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {BILLING_FIELDS.map((f) => (
                    <div key={f.key} className={`space-y-1.5 ${f.key === 'bill_address' || f.key === 'bill_address_2' ? 'sm:col-span-2' : ''}`}>
                      <Label htmlFor={`so-${f.key}`} className={LABEL}>{f.label}</Label>
                      <Input
                        id={`so-${f.key}`}
                        type={f.type ?? 'text'}
                        value={String(header[f.key] ?? '')}
                        maxLength={f.maxLength}
                        onChange={(e) => setField(f.key, e.target.value as never)}
                      />
                    </div>
                  ))}
                </div>
              </fieldset>
            </section>

            <Section title="Dates">
              <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-3 text-sm">
                <dt><Label htmlFor="so-order-date" className={LABEL}>Order date</Label></dt>
                <dd>
                  <Input
                    id="so-order-date"
                    type="date"
                    value={orderDate}
                    disabled={locked || busy}
                    onChange={(e) => setOrderDate(e.target.value)}
                  />
                </dd>
                <dt><Label htmlFor="so-requested-date" className={LABEL}>Requested delivery date</Label></dt>
                <dd>
                  <Input
                    id="so-requested-date"
                    type="date"
                    value={requestedDate}
                    disabled={locked || busy}
                    onChange={(e) => setRequestedDate(e.target.value)}
                  />
                </dd>
                <dt className={LABEL}>Document date</dt>
                <dd className="text-foreground-muted">Set when invoiced</dd>
                <dt className={LABEL}>Posting date</dt>
                <dd className="text-foreground-muted">Set when invoiced</dd>
                <dt className={LABEL}>Due date</dt>
                <dd className="text-foreground">
                  <span data-testid="due-date">{order?.bc_due_date || '—'}</span>
                  {order?.bc_due_date && <span className="ml-1 text-xs text-foreground-subtle">(from BC)</span>}
                </dd>
              </dl>
            </Section>
          </div>

          <Section title="Ship to">
            <ShipToPicker
              rows={shipTos}
              defaultCode={defaultShipCode}
              choice={shipChoice}
              address={shipAddress}
              saveToCustomer={saveToCustomer}
              canSaveToCustomer={canSaveShipTo}
              disabled={locked || busy}
              onChoose={chooseShipTo}
              onAddressChange={(patch) => setHeader((h) => ({ ...h, ...patch }))}
              onSaveToCustomerChange={setSaveToCustomer}
            />
          </Section>

          <Section title="Terms & posting">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {TERM_FIELDS.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label htmlFor={`so-${f.key}`} className={LABEL}>{f.label}</Label>
                  <select
                    id={`so-${f.key}`}
                    className={SELECT_CLASS}
                    value={header[f.key]}
                    disabled={locked || busy}
                    onChange={(e) => setField(f.key, e.target.value)}
                  >
                    <option value="">—</option>
                    {withCurrent(selectOptions[f.list] ?? [], header[f.key]).map((o) => (
                      <option key={o.code} value={o.code}>{o.label}</option>
                    ))}
                  </select>
                </div>
              ))}
              <div className="flex items-center gap-2 pt-5">
                <Switch
                  id="so-tax-liable"
                  checked={header.tax_liable}
                  disabled={locked || busy}
                  onCheckedChange={(v) => setField('tax_liable', v)}
                />
                <Label htmlFor="so-tax-liable" className="text-sm">Tax liable</Label>
              </div>
            </div>
          </Section>

          <Section title="Lines">
            <SalesOrderLinesTable lines={shownLines} items={items} locked={locked || busy} onChange={setDraftLines} />
            <dl className="ml-auto mt-4 grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-sm">
              <dt className="text-foreground-muted">Subtotal</dt>
              <dd data-testid="total-subtotal" className="text-right text-foreground">{total(order?.total_excl_tax)}</dd>
              <dt className="text-foreground-muted">Tax (from BC)</dt>
              <dd data-testid="total-tax" className="text-right text-foreground">{total(order?.total_tax)}</dd>
              <dt className="font-semibold text-foreground">Total</dt>
              <dd data-testid="total-total" className="text-right font-semibold text-foreground">{total(order?.total_incl_tax)}</dd>
            </dl>
          </Section>

          <Section title="Notes">
            <Label htmlFor="so-notes" className="sr-only">Notes</Label>
            <textarea
              id="so-notes"
              rows={3}
              value={notes}
              disabled={!canEdit || busy}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
            />
          </Section>

          {canEdit && (
            <div className="flex justify-end gap-2 pb-4">
              {order && canDelete(order.status) && (
                <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmDelete(true)}>
                  Delete
                </Button>
              )}
              <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
            </div>
          )}
        </div>
      </form>

      <Dialog open={confirmDelete} onOpenChange={(o) => { if (!o && !busy) setConfirmDelete(false); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete this sales order?</DialogTitle>
            <DialogDescription>
              {order?.bc_order_number
                ? `Order ${order.bc_order_number} will also be deleted in Business Central.`
                : 'The order will be deleted from Nexus.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={remove}>
              Delete order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
