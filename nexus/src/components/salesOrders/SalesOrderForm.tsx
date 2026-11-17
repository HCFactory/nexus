'use client';

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';

import {
  deleteSalesOrder,
  getSalesOrderPriceLines,
  overwriteBcWithNexus,
  retrySalesOrderSync,
  saveSalesOrder,
  setSalesOrderStatus,
  type SalesOrderFormContext,
} from '@/app/actions/salesOrders';
import { refreshShipTos, saveShipToAction } from '@/app/actions/shipToAddresses';
import { startChangeInvoice } from '@/app/actions/salesInvoiceChanges';
import { changeLinesFromDrafts, changeSubtotalCents, sameLines, toChangeLines } from '@/lib/salesOrders/invoiceChangeLines';
import { FAILED_CHANGE_STATES, type ChangeLine, type InvoiceChangeRow } from '@/types/invoiceChanges';
import { ChangeInvoiceDialog } from './ChangeInvoiceDialog';
import { GlassButton as Button } from './GlassButton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { bestPrice } from '@/lib/salesOrders/bestPrice';
import { lineAmounts, orderTotals, taxLabel, taxRatePercent } from '@/lib/salesOrders/lineAmounts';
import { applyShipTo, customerDefaults } from '@/lib/salesOrders/orderDefaults';
import { autoInvoiceNumber, canDelete, canStartInvoice, editableFields } from '@/lib/salesOrders/orderRules';
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
import { ChangeInvoiceButton, InvoiceChangeStatus, InvoiceControls, InvoiceStatus, SAVE_FIRST, isInvoiceLocked, isInvoiceRunning, showsCreateInvoice } from './InvoiceControls';

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
  /** Why Create invoice is blocked for this customer (Bill.com), or null when ready. */
  invoiceBlockedReason?: string | null;
  /** The order's open invoice change, if any. */
  invoiceChange?: InvoiceChangeRow | null;
  /** Why Change invoice is disabled (Bill.com: paid, void, unreachable), or null. */
  changeBlockedReason?: string | null;
}

type Option = { code: string; label: string };

const FORM_ID = 'sales-order-form';
const POLL_MS = 4000;
const MAX_POLLS = 15;
const INVOICE_POLL_MS = 3000;
const MAX_INVOICE_POLLS = 40;

const LABEL = 'text-[11px] uppercase tracking-wide text-black dark:text-white';
const INPUT_CLASS = 'border-input bg-field dark:bg-field';
const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-field px-3 text-sm text-foreground shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60';

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

/** An open change's line, shown (locked) in the lines table. */
function changeLineDraft(l: ChangeLine, i: number): LineDraft {
  return {
    key: `change-${i}`,
    item_number: l.item_number,
    description: l.description,
    quantity: l.quantity,
    unit_price: l.unit_price,
    discount_percent: l.discount_percent,
    unit_of_measure_code: l.unit_of_measure_code,
    amount_incl_tax: null,
    estimate_price: null,
    bc_unit_price: null,
    bc_line_discount_percent: null,
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
    <section className="glass-card p-4">
      <h2 className="mb-3 text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

export function SalesOrderForm({ order, lines, context, shipTos: initialShipTos, canEdit, canSaveShipTo, notes = [], invoiceBlockedReason, invoiceChange: openChange = null, changeBlockedReason = null }: Props) {
  const router = useRouter();
  const { customers, items, selectOptions, companyLocation, today, taxAreaLines, taxDetails } = context;
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
  const [invoiceChange, setInvoiceChange] = useState<{ from: string; to: string; saveAfter: boolean } | null>(null);
  const [customerPo, setCustomerPo] = useState(order?.customer_po ?? '');
  const loadedDrafts = () => {
    const estimates = new Map(items.map((i) => [i.bc_item_number, i.unit_price]));
    return lines.map((l) => lineDraftOf(l, estimates));
  };
  const [draftLines, setDraftLines] = useState<LineDraft[]>(loadedDrafts);
  // Change invoice: the lines unlock (only them) until Save changes to invoice or Cancel changes.
  const [changeMode, setChangeMode] = useState(false);
  const [changeDialog, setChangeDialog] = useState(false);
  // Bumped by Cancel changes so the lines table drops the cells' typed text.
  const [linesVersion, setLinesVersion] = useState(0);
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

  // While an invoice is posting or after it posted, the order is locked and polls for the next step.
  const invoiceState = order?.invoice_state ?? 'none';
  // An open change polls until it finishes or a step fails.
  const changeRunning = invoiceState === 'changing' && !(openChange && FAILED_CHANGE_STATES.includes(openChange.state));
  useEffect(() => {
    if (!orderId || !(isInvoiceRunning(invoiceState) || changeRunning)) return;
    let polls = 0;
    const timer = setInterval(() => {
      polls += 1;
      router.refresh();
      if (polls >= MAX_INVOICE_POLLS) clearInterval(timer);
    }, INVOICE_POLL_MS);
    return () => clearInterval(timer);
  }, [orderId, invoiceState, changeRunning, router]);

  const invoiceLocked = isInvoiceLocked(invoiceState);
  // The BC sync state (with Try again / Overwrite) shows before invoicing, and
  // after a failed post when the order isn't In BC (a rep fixing it before Retry).
  const showSyncBadge = invoiceState === 'none' || (invoiceState === 'post_failed' && order?.sync_state !== 'synced');
  const locked = !canEdit || invoiceLocked || (order ? editableFields(order.status) !== 'all' : false);
  const busy = pending;
  const invoiceShown = invoiceNumber ?? autoInvoiceNumber(order?.bc_order_number ?? null, customerPo);

  const currentCustomer = (): CustomerRow =>
    customers.find((c) => c.id === customerId) ?? customerFromHeader(customerId, customerNumber, defaultShipCode, header);

  // Price-list lines for the chosen customer only; a customer switch fetches the new customer's.
  // Until they arrive, the other customer's lines simply don't match (bestPrice filters by customer).
  const [priceListLines, setPriceListLines] = useState(context.priceListLines);
  const priceLinesFor = useRef(order?.customer_number ?? '');
  useEffect(() => {
    if (customerNumber === priceLinesFor.current) return;
    priceLinesFor.current = customerNumber;
    let current = true;
    getSalesOrderPriceLines(customerNumber)
      .then((rows) => { if (current) setPriceListLines(rows); })
      .catch((e: unknown) => console.error('[sales-orders] could not load price lines:', e));
    return () => { current = false; };
  }, [customerNumber]);

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
  // They only apply while the line still has the item and quantity BC priced, for the same customer.
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
  // BC re-prices when the customer changes, so its old price, discount and amount no longer apply.
  const sameCustomer = !order || customerId === order.customer_id;
  const shownLines = draftLines.map((l) => {
    const est = estimateOf(l);
    const withEstimate = { ...l, estimate_price: est.unitPrice, estimate_discount_percent: est.discountPercent };
    const r = l.id ? readBack.get(l.id) : undefined;
    if (!sameCustomer) return { ...withEstimate, amount_incl_tax: null, bc_unit_price: null, bc_line_discount_percent: null };
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
      // A one-off ship-to starts with the customer's name; the rep can change it.
      setHeader((h) => ({ ...h, ship_to_code: '', ship_to_name: customerName }));
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

  /** Opens the invoice # confirm if the rep changed it since focusing the field; true when it opened. */
  function askInvoiceChange(saveAfter: boolean): boolean {
    if (invoiceNumber === invoiceAtFocus.current.value || invoiceAtFocus.current.shown === invoiceShown) return false;
    setInvoiceChange((c) => ({ from: invoiceAtFocus.current.shown, to: invoiceShown, saveAfter: saveAfter || (c?.saveAfter ?? false) }));
    return true;
  }

  /** `nextStatus`: the status just picked (state may not have updated yet). */
  function save(nextStatus: OrderStatus = status) {
    setError(null);
    if (!customerId || !customerNumber) {
      setError('Choose a customer.');
      return;
    }
    startTransition(async () => {
      // Only the status changed (or the order is locked): status is Nexus-only, so skip the save (and its BC sync).
      if (order && nextStatus !== order.status && (locked || !otherEdits)) {
        const res = await setSalesOrderStatus(order.id, nextStatus);
        if (!res.ok) {
          setError(res.error);
          setStatus(order.status);
        } else router.refresh();
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
        status: nextStatus,
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
  const formUnchanged =
    !!order &&
    !!loadedHeader &&
    customerId === order.customer_id &&
    orderDate === order.order_date &&
    HEADER_KEYS.every((k) => header[k] === loadedHeader[k]) &&
    linesUnchanged(draftLines, lines);
  // Unsaved edits other than the status: anything the totals check sees, plus the Invoice # and PO the invoice also uses.
  const otherEdits = !formUnchanged || invoiceNumber !== (order?.invoice_number ?? null) || customerPo !== order?.customer_po;
  const dirty = otherEdits || status !== order?.status;

  /** Picking a status saves it at once on a saved order (with any other unsaved edits); a new order just keeps it. */
  function changeStatus(next: OrderStatus) {
    setStatus(next);
    if (!order || next === order.status) return;
    save(next);
  }
  const bcTotals =
    order &&
    formUnchanged &&
    order.sync_state === 'synced' &&
    num(order.total_incl_tax) !== null
      ? { subtotal: num(order.total_excl_tax) ?? 0, tax: num(order.total_tax) ?? 0, total: num(order.total_incl_tax) ?? 0 }
      : null;
  // An open change shows the corrected lines (locked) until it finishes.
  const changeLines = openChange ? openChange.lines_after.map(changeLineDraft) : null;
  const displayLines = changeLines ?? shownLines;
  const totals = changeLines
    ? orderTotals(changeLines.map((l) => lineAmounts(l, taxRate(l))))
    : bcTotals ?? orderTotals(shownLines.map((l) => lineAmounts(l, taxRate(l))));
  // In change mode: the edits as change lines, and whether they differ from what was invoiced.
  const changeResult = changeMode ? changeLinesFromDrafts(draftLines, lines) : null;
  const changeEdited = !!changeResult && (!changeResult.ok || !sameLines(toChangeLines(lines), changeResult.lines));
  const linesLocked = changeMode ? busy : locked || busy;

  const cancelChange = () => {
    setDraftLines(loadedDrafts());
    setLinesVersion((v) => v + 1);
    setChangeMode(false);
  };
  const confirmChange = async (reason: string): Promise<string | null> => {
    if (!order) return null;
    const res = await startChangeInvoice(order.id, draftLines, reason);
    if (!res.ok) return res.error;
    setChangeDialog(false);
    setChangeMode(false);
    router.refresh();
    return null;
  };
  const shipAddress = Object.fromEntries(SHIP_ADDRESS_KEYS.map((k) => [k, header[k]])) as ShipToAddressFields;

  return (
    <div className="flex h-[calc(100vh-3.5rem)] min-h-0 flex-col overflow-hidden">
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
        {/* Sync state sits above the buttons; the column is no taller than the title block. */}
        <div className="flex flex-col items-end gap-1.5">
          {order && (invoiceState !== 'none' || showSyncBadge) && (
            <div className="-mt-2.5 flex items-center justify-end gap-3 whitespace-nowrap text-xs leading-4">
              {invoiceState !== 'none' && (
                <InvoiceStatus
                  className="text-xs leading-4"
                  order={order}
                  canEdit={canEdit}
                  onError={setError}
                />
              )}
              {openChange && <InvoiceChangeStatus orderId={order.id} change={openChange} canEdit={canEdit} onError={setError} />}
              {showSyncBadge && (
                <SyncBadge
                  className="text-xs leading-4"
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
            </div>
          )}
          <div className="flex items-center gap-2">
            <StatusSelect value={status} onChange={changeStatus} disabled={!canEdit || busy || invoiceLocked} />
            {order && (
              <InvoiceControls
                order={order}
                canEdit={canEdit}
                dirty={dirty}
                blockedReason={invoiceBlockedReason}
                invoiceNumber={invoiceShown}
                customerLabel={customerName}
                total={totals.total}
                today={today}
              />
            )}
            {order && !changeMode && !openChange && (
              <ChangeInvoiceButton order={order} canEdit={canEdit} blockedReason={changeBlockedReason} onStart={() => setChangeMode(true)} />
            )}
            {canEdit && !invoiceLocked && (
              <Button type="submit" variant="blue-glass" form={FORM_ID} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
            )}
            {canEdit && invoiceState === 'none' && order && canDelete(order.status) && (
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Delete order"
                title="Delete order"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
                className="text-foreground-muted! hover:text-destructive!"
              >
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>
        </div>
      </header>

      {error && (
        <div role="alert" className="border-b border-border bg-destructive-subtle px-5 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {order && showsCreateInvoice(order, canEdit) && (invoiceBlockedReason || (dirty && canStartInvoice(order))) && (
        <div className="border-b border-border bg-surface px-5 py-2 text-sm text-foreground-muted">
          {invoiceBlockedReason || SAVE_FIRST}
        </div>
      )}
      {order && canEdit && (invoiceState === 'post_failed' || invoiceState === 'billcom_failed') && order.invoice_error && (
        <div className="border-b border-border bg-warning-subtle px-5 py-2 text-sm text-foreground">{order.invoice_error}</div>
      )}
      {order && canEdit && locked && !invoiceLocked && (
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
            <section className="glass-card p-4">
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
              <div className="space-y-4" data-testid="order-fields">
                <div className="space-y-1.5">
                  <Label htmlFor="so-customer" className={LABEL}>Customer</Label>
                  <CustomerPicker
                    customers={customers}
                    selectedLabel={customerLabel(customerNumber, customerName)}
                    disabled={locked || busy}
                    onPick={pickCustomer}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="so-customer-po" className={LABEL}>Customer PO</Label>
                    <Input
                      id="so-customer-po"
                      className={INPUT_CLASS}
                      value={customerPo}
                      maxLength={100}
                        disabled={locked || busy}
                      onChange={(e) => setCustomerPo(e.target.value)}
                    />
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
                      onBlur={() => { askInvoiceChange(false); }}
                      onKeyDown={(e) => {
                        // Enter would save the form: confirm a changed invoice # first, then save on Keep.
                        if (e.key === 'Enter' && askInvoiceChange(true)) e.preventDefault();
                      }}
                    />
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
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
              </div>
            </section>

            <Section title="Notes">
              <NotesPanel orderId={order?.id ?? null} canEdit={canEdit} initialNotes={notes} />
            </Section>
          </div>

          <Section title="Order Items">
            {changeMode && order && (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm text-foreground">
                <span className="flex-1">Changing invoice {invoiceShown} — edit lines, then Save changes to invoice.</span>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={cancelChange}>Cancel changes</Button>
                <Button type="button" size="sm" variant="blue-glass" disabled={busy || !changeEdited} onClick={() => setChangeDialog(true)}>
                  Save changes to invoice
                </Button>
              </div>
            )}
            <SalesOrderLinesTable
              key={linesVersion}
              lines={displayLines}
              items={items}
              locked={linesLocked || !!changeLines}
              onChange={setDraftLines}
            />
            {changeMode && order && (
              <ChangeInvoiceDialog
                open={changeDialog}
                oldTotal={num(order.posted_total_incl_tax)}
                newSubtotal={changeResult?.ok ? changeSubtotalCents(changeResult.lines) / 100 : totals.subtotal}
                oldBcNumber={order.bc_posted_invoice_number ?? ''}
                onConfirm={confirmChange}
                onClose={() => setChangeDialog(false)}
              />
            )}
            <dl className="ml-auto mt-4 grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-sm">
              <dt className="text-foreground-muted">Subtotal</dt>
              <dd data-testid="total-subtotal" className="text-right text-foreground">{money(totals.subtotal)}</dd>
              <dt className="text-foreground-muted">{taxLabel(displayLines.map(taxRate))}</dt>
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
              {invoiceChange?.from
                ? `You changed the invoice number from ${invoiceChange.from} to ${invoiceChange.to}. Keep it?`
                : `You set the invoice number to ${invoiceChange?.to ?? ''}. Keep it?`}
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
            <Button
              type="button"
              size="sm"
              onClick={() => {
                const saveAfter = invoiceChange?.saveAfter ?? false;
                invoiceAtFocus.current = { value: invoiceNumber, shown: invoiceShown };
                setInvoiceChange(null);
                if (saveAfter) save();
              }}
            >
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
