'use client';

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from 'react';
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
import { bestPrice } from '@/lib/salesOrders/bestPrice';
import { lineAmounts, orderTotals, taxRatePercent } from '@/lib/salesOrders/lineAmounts';
import { applyShipTo, customerDefaults } from '@/lib/salesOrders/orderDefaults';
import { autoInvoiceNumber, canDelete, editableFields } from '@/lib/salesOrders/orderRules';
import type {
  CustomerRow,
  LineDraft,
  OrderHeaderDefaults,
  OrderStatus,
  SalesOrderInput,
  SalesOrderLineRow,
  SalesOrderNoteView,
  SalesOrderRow,
  ShipToRow,
} from '@/types/salesOrders';
import { BillingCard, ShipToCard } from './AddressCards';
import { CustomerPicker, customerLabel } from './CustomerPicker';
import { NotesPanel } from './NotesPanel';
import { SalesOrderLinesTable } from './SalesOrderLinesTable';
import type { ShipToAddressFields, ShipToChoice } from './ShipToPicker';
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
  /** Note entries; they save on their own, so they stay editable on a locked order. */
  notes?: SalesOrderNoteView[];
  /** "Save to customer" on a one-off ship-to needs customer edit permission. */
  canSaveShipTo: boolean;
}

type Option = { code: string; label: string };

const FORM_ID = 'sales-order-form';
const POLL_MS = 4000;
const MAX_POLLS = 15;

const LABEL = 'text-[11px] uppercase tracking-wide text-foreground-subtle';
const INPUT_CLASS = 'border-input bg-background';
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

type TermKey = 'payment_terms_code' | 'shipment_method_code' | 'tax_area_code';
const INVOICING_FIELDS: { key: TermKey; label: string; list: string }[] = [
  { key: 'payment_terms_code', label: 'Payment terms', list: 'paymentTerms' },
  { key: 'tax_area_code', label: 'Tax area', list: 'taxAreas' },
];

function SelectField({ id, label, value, options, disabled, onChange }: {
  id: string; label: string; value: string; options: Option[]; disabled: boolean; onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className={LABEL}>{label}</Label>
      <select id={id} className={SELECT_CLASS} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {withCurrent(options, value).map((o) => (
          <option key={o.code} value={o.code}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

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
    discount_percent: num(row.discount_percent),
    unit_of_measure_code: row.unit_of_measure_code ?? '',
    amount_incl_tax: num(row.amount_incl_tax),
    estimate_price: estimates.get(row.item_number) ?? null,
    bc_unit_price: num(row.bc_unit_price),
    bc_line_discount_percent: num(row.bc_line_discount_percent),
  };
}

/** True when the edited lines still match the loaded ones (same lines, same order, same values). */
function linesUnchanged(draft: LineDraft[], loaded: SalesOrderLineRow[]): boolean {
  return (
    draft.length === loaded.length &&
    draft.every((d, i) => {
      const r = loaded[i];
      return (
        d.id === r.id &&
        d.item_number === r.item_number &&
        d.quantity === Number(r.quantity) &&
        d.unit_price === num(r.unit_price) &&
        d.discount_percent === num(r.discount_percent) &&
        d.unit_of_measure_code === (r.unit_of_measure_code ?? '')
      );
    })
  );
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
    // Unknown for a customer that is no longer pickable; the estimate falls back to customer-specific and all-customer lists.
    customer_price_group: '',
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

export function SalesOrderForm({ order, lines, context, shipTos: initialShipTos, canEdit, canSaveShipTo, notes = [] }: Props) {
  const router = useRouter();
  const { customers, items, selectOptions, companyLocation, today, priceListLines, taxAreaLines, taxDetails } = context;
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
  const [invoiceNumber, setInvoiceNumber] = useState<string | null>(order?.invoice_number ?? null);
  const invoiceAtFocus = useRef<{ value: string | null; shown: string }>({ value: null, shown: '' });
  const [invoiceChange, setInvoiceChange] = useState<{ from: string; to: string } | null>(null);
  const [customerPo, setCustomerPo] = useState(order?.customer_po ?? '');
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
  const invoiceShown = invoiceNumber ?? autoInvoiceNumber(order?.bc_order_number ?? null, customerPo);

  const currentCustomer = (): CustomerRow =>
    customers.find((c) => c.id === customerId) ?? customerFromHeader(customerId, customerNumber, defaultShipCode, header);

  // The price estimate for blank lines: BC's best price from the customer's price lists, else the item price.
  const priceGroup = customers.find((c) => c.id === customerId)?.customer_price_group ?? '';
  const itemPrices = useMemo(() => new Map(items.map((i) => [i.bc_item_number, i.unit_price])), [items]);
  const estimateOf = (l: LineDraft) =>
    bestPrice(
      priceListLines,
      {
        customerNumber,
        priceGroup,
        itemNumber: l.item_number,
        uom: l.unit_of_measure_code,
        quantity: l.quantity,
        orderDate,
      },
      itemPrices.get(l.item_number) ?? null,
    );

  // Read-back amounts and BC prices arrive on refresh; show them without discarding the rep's unsaved edits.
  // They only apply while the line still has the item and quantity BC priced.
  const readBack = new Map(
    lines.map((l) => [
      l.id,
      {
        item: l.item_number,
        quantity: Number(l.quantity),
        amount: num(l.amount_incl_tax),
        price: num(l.bc_unit_price),
        discount: num(l.bc_line_discount_percent),
      },
    ]),
  );
  const shownLines = draftLines.map((l) => {
    const est = estimateOf(l);
    const withEstimate = { ...l, estimate_price: est.unitPrice, estimate_discount_percent: est.discountPercent };
    const r = l.id ? readBack.get(l.id) : undefined;
    return r && r.item === l.item_number && r.quantity === l.quantity
      ? { ...withEstimate, amount_incl_tax: r.amount, bc_unit_price: r.price, bc_line_discount_percent: r.discount }
      : withEstimate;
  });

  // Live tax: the order's tax area and liability, the item's tax group, rates in effect on the order date.
  const taxGroups = useMemo(() => new Map(items.map((i) => [i.bc_item_number, i.tax_group_code ?? ''])), [items]);
  const taxRate = (l: LineDraft) =>
    taxRatePercent(
      {
        taxAreaCode: header.tax_area_code,
        taxGroupCode: taxGroups.get(l.item_number) ?? '',
        date: orderDate,
        taxLiable: header.tax_liable,
      },
      taxAreaLines,
      taxDetails,
    );

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
      if (order && locked && status !== order.status) {
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
        invoice_number: invoiceNumber?.trim() || null,
        customer_po: customerPo,
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

  // BC's figures while the order is synced and nothing changed since load; otherwise the live estimate.
  const loadedHeader = order ? headerOf(order) : null;
  const bcTotals =
    order &&
    loadedHeader &&
    order.sync_state === 'synced' &&
    num(order.total_incl_tax) !== null &&
    customerId === order.customer_id &&
    orderDate === order.order_date &&
    HEADER_KEYS.every((k) => header[k] === loadedHeader[k]) &&
    linesUnchanged(draftLines, lines)
      ? { subtotal: num(order.total_excl_tax) ?? 0, tax: num(order.total_tax) ?? 0, total: num(order.total_incl_tax) ?? 0 }
      : null;
  const showBc = bcTotals !== null;
  const totals = bcTotals ?? orderTotals(shownLines.map((l) => lineAmounts(l, taxRate(l))));
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
        {canEdit && order && canDelete(order.status) && (
          <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        )}
        {canEdit && (
          <Button type="submit" form={FORM_ID} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
        )}
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
        id={FORM_ID}
        // `relative` contains absolutely positioned descendants (e.g. the
        // sr-only Notes label); without it they position against the page
        // and stretch the document, adding an extra page scroll.
        className="relative min-h-0 flex-1 overflow-y-auto p-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="mx-auto max-w-6xl space-y-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
            <section className="rounded-xl border border-border bg-surface-raised p-4 card-shadow">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-foreground">
                  {order?.bc_order_number ? `Order ${order.bc_order_number}` : 'Order'}
                </h2>
                <div className="flex items-center gap-2">
                  <Label htmlFor="so-order-date" className={LABEL}>Order date</Label>
                  <Input
                    id="so-order-date"
                    type="date"
                    className={`${INPUT_CLASS} w-auto`}
                    value={orderDate}
                    disabled={locked || busy}
                    onChange={(e) => setOrderDate(e.target.value)}
                  />
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5 md:col-span-2">
                  <Label htmlFor="so-customer" className={LABEL}>Customer</Label>
                  <CustomerPicker
                    customers={customers}
                    selectedLabel={customerLabel(customerNumber, customerName)}
                    disabled={locked || busy}
                    onPick={pickCustomer}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="so-customer-po" className={LABEL}>Customer PO</Label>
                  <Input
                    id="so-customer-po"
                    className={INPUT_CLASS}
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
                <div className="space-y-1.5">
                  <Label htmlFor="so-invoice" className={LABEL}>Invoice # (Ext. Doc No.)</Label>
                  <Input
                    id="so-invoice"
                    className={INPUT_CLASS}
                    value={invoiceShown}
                    maxLength={35}
                    placeholder="Set when sent to BC"
                    disabled={locked || busy}
                    onFocus={() => { invoiceAtFocus.current = { value: invoiceNumber, shown: invoiceShown }; }}
                    onChange={(e) => setInvoiceNumber(e.target.value === '' ? null : e.target.value)}
                    onBlur={() => {
                      if (invoiceNumber !== invoiceAtFocus.current.value) {
                        setInvoiceChange({ from: invoiceAtFocus.current.shown, to: invoiceShown });
                      }
                    }}
                  />
                </div>
                <SelectField
                  id="so-shipment_method_code"
                  label="Delivery method"
                  value={header.shipment_method_code}
                  options={selectOptions.shipmentMethods ?? []}
                  disabled={locked || busy}
                  onChange={(v) => setField('shipment_method_code', v)}
                />
                <div className="space-y-1.5">
                  <Label htmlFor="so-requested-date" className={LABEL}>Requested delivery date</Label>
                  <Input
                    id="so-requested-date"
                    type="date"
                    className={INPUT_CLASS}
                    value={requestedDate}
                    disabled={locked || busy}
                    onChange={(e) => setRequestedDate(e.target.value)}
                  />
                </div>
              </div>
            </section>

            <Section title="Notes">
              <NotesPanel orderId={order?.id ?? null} canEdit={canEdit} initialNotes={notes} />
            </Section>
          </div>

          <Section title="Order Items">
            <SalesOrderLinesTable
              lines={shownLines}
              items={items}
              locked={locked || busy}
              onChange={setDraftLines}
              taxRate={taxRate}
              showBcAmounts={showBc}
            />
            <dl className="ml-auto mt-4 grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-sm">
              <dt className="text-foreground-muted">Subtotal</dt>
              <dd data-testid="total-subtotal" className="text-right text-foreground">{money(totals.subtotal)}</dd>
              <dt className="text-foreground-muted">{showBc ? 'Tax' : 'Tax (estimate)'}</dt>
              <dd data-testid="total-tax" className="text-right text-foreground">{money(totals.tax)}</dd>
              <dt className="font-semibold text-foreground">Total</dt>
              <dd data-testid="total-total" className="text-right font-semibold text-foreground">{money(totals.total)}</dd>
            </dl>
          </Section>

          <div className="grid gap-4 md:grid-cols-2">
            <BillingCard
              values={header}
              editable={!(locked || busy)}
              onChange={(patch) => setHeader((h) => ({ ...h, ...patch }))}
            />
            <ShipToCard
              editable={!(locked || busy)}
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
          </div>

          <Section title="Invoicing">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {INVOICING_FIELDS.map((f) => (
                <SelectField
                  key={f.key}
                  id={`so-${f.key}`}
                  label={f.label}
                  value={header[f.key]}
                  options={selectOptions[f.list] ?? []}
                  disabled={locked || busy}
                  onChange={(v) => setField(f.key, v)}
                />
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
        </div>
      </form>

      <Dialog open={invoiceChange !== null} onOpenChange={(o) => { if (!o) setInvoiceChange(null); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Change invoice number?</DialogTitle>
            <DialogDescription>
              {`You changed the invoice number from ${invoiceChange?.from ?? ''} to ${invoiceChange?.to ?? ''}. Keep it?`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => { setInvoiceNumber(invoiceAtFocus.current.value); setInvoiceChange(null); }}
            >
              Undo
            </Button>
            <Button type="button" size="sm" onClick={() => setInvoiceChange(null)}>
              Keep
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
