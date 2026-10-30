'use client';

import Link from 'next/link';
import { useMemo, useState, useTransition, type FormEvent } from 'react';
import {
  createFriendsFamilyProduct,
  deleteFriendsFamilyOrder,
  getFriendsFamilyWorkspace,
  updateFriendsFamilyOrderStatus,
  updateFriendsFamilyProduct,
} from '@/app/actions/friendsFamilyOrders';
import { FriendsFamilyOrderForm } from './FriendsFamilyOrderForm';
import { FRIENDS_FAMILY_PRODUCT_COLORS, getFriendsFamilyProductColor } from '@/lib/friendsFamily/productColors';
import type {
  FriendsFamilyFulfillmentStatus,
  FriendsFamilyOrderWithItems,
  FriendsFamilyPaymentStatus,
  FriendsFamilyProduct,
  FriendsFamilyProductColor,
  FriendsFamilyWorkspace,
} from '@/types/database';
import { ChevronDown, ExternalLink, PackagePlus, Pencil, Plus, Search, Settings2, Trash2, X } from 'lucide-react';

const FULFILLMENT_LABELS: Record<FriendsFamilyFulfillmentStatus, string> = {
  new: 'New',
  packed: 'Packed',
  fulfilled: 'Fulfilled',
};

const PAYMENT_LABELS: Record<FriendsFamilyPaymentStatus, string> = {
  unpaid: 'Unpaid',
  cash_paid: 'Cash Paid',
  square_paid: 'Square Paid',
  venmo_paid: 'Venmo Paid',
};

function money(value: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function ProductColorSelect({
  value,
  onChange,
  label,
}: {
  value: FriendsFamilyProductColor;
  onChange: (value: FriendsFamilyProductColor) => void;
  label: string;
}) {
  const color = getFriendsFamilyProductColor(value);
  return (
    <label className="relative flex items-center gap-2 rounded-lg border border-border bg-surface-raised px-2">
      <span className="size-4 shrink-0 rounded-full border" style={{ backgroundColor: color.background, borderColor: color.border }} />
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value as FriendsFamilyProductColor)}
        className="min-w-0 flex-1 bg-transparent py-2 text-sm text-foreground outline-none"
      >
        {FRIENDS_FAMILY_PRODUCT_COLORS.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function statusClass(kind: 'fulfillment' | 'payment', value: string) {
  if (value === 'fulfilled' || value === 'cash_paid') return 'border-success/30 bg-success-subtle text-success';
  if (value === 'square_paid') return 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300';
  if (value === 'packed' || value === 'venmo_paid') return 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300';
  if (value === 'new' || (kind === 'payment' && value === 'unpaid')) return 'border-warning/30 bg-warning-subtle text-warning';
  return 'border-border bg-surface-raised text-foreground-muted';
}

function StatusSelect<T extends string>({
  label,
  value,
  options,
  kind,
  disabled,
  widthClass,
  onChange,
}: {
  label: string;
  value: T;
  options: Record<T, string>;
  kind: 'fulfillment' | 'payment';
  disabled: boolean;
  widthClass: string;
  onChange: (value: T) => void;
}) {
  return (
    <label className="relative">
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
        className={`${widthClass} appearance-none rounded-full border py-0.5 pl-2 pr-6 text-xs font-semibold leading-tight sm:py-1.5 sm:pl-3 sm:pr-8 sm:leading-normal outline-none transition focus:ring-2 focus:ring-ring disabled:opacity-60 ${statusClass(kind, value)}`}
      >
        {(Object.keys(options) as T[]).map((optionValue) => (
          <option key={optionValue} value={optionValue}>
            {options[optionValue]}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 sm:right-2.5" />
    </label>
  );
}

function OrderCard({
  order,
  products,
  onChanged,
}: {
  order: FriendsFamilyOrderWithItems;
  products: FriendsFamilyProduct[];
  onChanged: () => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);

  const updateStatus = (
    patch: Partial<Pick<FriendsFamilyOrderWithItems, 'fulfillment_status' | 'payment_status'>>
  ) => {
    startTransition(async () => {
      await updateFriendsFamilyOrderStatus(order.id, patch);
      await onChanged();
    });
  };

  const deleteOrder = () => {
    if (!window.confirm(`Delete ${order.order_number} permanently?`)) return;
    startTransition(async () => {
      await deleteFriendsFamilyOrder(order.id);
      await onChanged();
    });
  };

  if (editing) {
    return (
      <FriendsFamilyOrderForm
        products={products}
        initialOrder={order}
        onCancel={() => setEditing(false)}
        onSaved={async () => {
          await onChanged();
          setEditing(false);
        }}
        onDeleted={async () => {
          await onChanged();
          setEditing(false);
        }}
      />
    );
  }

  return (
    <article className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
      <header className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3 border-b border-border bg-surface-raised/40 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="text-sm font-bold text-foreground">{order.order_number}</h2>
          <span className="text-sm font-medium text-foreground">{order.customer_name}</span>
          <span className="text-xs text-foreground-muted">Ordered by {order.ordered_by}</span>
          {order.phone && <span className="text-xs text-foreground-subtle">{order.phone}</span>}
          {order.email && <span className="text-xs text-foreground-subtle">{order.email}</span>}
          <span className="ml-auto text-xs text-foreground-subtle">{formatDate(order.created_at)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusSelect
            label={`Fulfillment status for ${order.order_number}`}
            value={order.fulfillment_status}
            options={FULFILLMENT_LABELS}
            kind="fulfillment"
            widthClass="w-[105px] sm:w-auto"
            disabled={pending}
            onChange={(fulfillment_status) => updateStatus({ fulfillment_status })}
          />
          <StatusSelect
            label={`Payment status for ${order.order_number}`}
            value={order.payment_status}
            options={PAYMENT_LABELS}
            kind="payment"
            widthClass="w-[140px] sm:w-auto"
            disabled={pending}
            onChange={(payment_status) => updateStatus({ payment_status })}
          />
          <button type="button" onClick={() => setEditing(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-surface" aria-label={`Edit ${order.order_number}`}>
            <Pencil className="size-3.5" /> Edit
          </button>
          <button type="button" disabled={pending} onClick={deleteOrder} className="rounded-lg border border-destructive/30 p-1.5 text-destructive hover:bg-destructive-subtle disabled:opacity-50" aria-label={`Delete ${order.order_number}`}>
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-xs">
          <thead className="border-b border-border bg-surface/60 uppercase tracking-wider text-foreground-subtle">
            <tr>
              <th className="px-4 py-1.5 font-semibold">Product</th>
              <th className="px-4 py-1.5 font-semibold">Category</th>
              <th className="px-4 py-1.5 text-right font-semibold">Qty</th>
              <th className="px-4 py-1.5 text-right font-semibold">Unit price</th>
              <th className="px-4 py-1.5 text-right font-semibold">Subtotal</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {order.items.map((item) => (
              <tr key={item.id} className="text-foreground-muted">
                <td className="px-4 py-2 font-medium text-foreground">{item.product_name}</td>
                <td className="px-4 py-2">{item.category_name}</td>
                <td className="px-4 py-2 text-right tabular-nums">{item.quantity}</td>
                <td className="px-4 py-2 text-right tabular-nums">{money(item.unit_price)}</td>
                <td className="px-4 py-2 text-right font-semibold tabular-nums text-foreground">{money(item.subtotal)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-border bg-surface-raised/30">
            <tr>
              <td colSpan={4} className="px-4 py-2 text-right font-semibold text-foreground-muted">Total</td>
              <td className="px-4 py-2 text-right text-sm font-bold tabular-nums text-foreground">{money(order.total_amount)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {order.notes && <div className="border-t border-border px-4 py-2 text-xs"><span className="mr-2 font-semibold text-foreground">Notes</span><span className="whitespace-pre-wrap text-foreground-muted">{order.notes}</span></div>}
    </article>
  );
}
function ProductManager({
  products,
  onChanged,
  onClose,
}: {
  products: FriendsFamilyProduct[];
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [price, setPrice] = useState('');
  const [colorKey, setColorKey] = useState<FriendsFamilyProductColor>('slate');
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();

  const saveNewProduct = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    startTransition(async () => {
      try {
        await createFriendsFamilyProduct({ name, category, unit_price: Number(price), color_key: colorKey });
        setName('');
        setCategory('');
        setPrice('');
        setColorKey('slate');
        await onChanged();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Product could not be saved.');
      }
    });
  };

  const saveProduct = (
    productId: string,
    patch: Partial<Pick<FriendsFamilyProduct, 'name' | 'category' | 'unit_price' | 'color_key' | 'active'>>
  ) => {
    setError('');
    startTransition(async () => {
      try {
        await updateFriendsFamilyProduct(productId, patch);
        await onChanged();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Product could not be updated.');
      }
    });
  };

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
      <div className="flex items-center justify-between border-b border-border bg-surface-raised/40 px-4 py-4 lg:px-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-primary">Admin</p>
          <h2 className="mt-0.5 text-lg font-bold text-foreground">Friends &amp; Family products</h2>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-2 text-foreground-subtle hover:bg-surface-raised hover:text-foreground" aria-label="Close product manager">
          <X className="size-5" />
        </button>
      </div>

      <form onSubmit={saveNewProduct} className="grid gap-3 border-b border-border p-4 sm:grid-cols-[1fr_1fr_140px_140px_auto] lg:p-5">
        <input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Product name" className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring" />
        <input required value={category} onChange={(event) => setCategory(event.target.value)} placeholder="Category" className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring" />
        <input required min="0" step="0.01" type="number" value={price} onChange={(event) => setPrice(event.target.value)} placeholder="Unit price" className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring" />
        <ProductColorSelect value={colorKey} onChange={setColorKey} label="New product color" />
        <button type="submit" disabled={pending} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50">
          <Plus className="size-4" /> Add
        </button>
      </form>
      {error && <p role="alert" className="px-4 pt-3 text-sm text-destructive lg:px-5">{error}</p>}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] text-sm">
          <thead className="border-b border-border text-left text-[11px] uppercase tracking-wider text-foreground-subtle">
            <tr>
              <th className="px-4 py-2.5 font-semibold lg:px-5">Product</th>
              <th className="px-4 py-2.5 font-semibold">Category</th>
              <th className="px-4 py-2.5 text-right font-semibold">Unit price</th>
              <th className="px-4 py-2.5 font-semibold">Color</th>
              <th className="px-4 py-2.5 text-right font-semibold lg:px-5">Availability</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {products.map((product) => (
              <ProductRow key={product.id} product={product} pending={pending} onSave={saveProduct} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ProductRow({
  product,
  pending,
  onSave,
}: {
  product: FriendsFamilyProduct;
  pending: boolean;
  onSave: (productId: string, patch: Partial<Pick<FriendsFamilyProduct, 'name' | 'category' | 'unit_price' | 'color_key' | 'active'>>) => void;
}) {
  const [name, setName] = useState(product.name);
  const [category, setCategory] = useState(product.category);
  const [price, setPrice] = useState(String(product.unit_price));
  const [colorKey, setColorKey] = useState(product.color_key);
  const changed = name.trim() !== product.name || category.trim() !== product.category || Number(price) !== product.unit_price || colorKey !== product.color_key;

  return (
    <tr className={!product.active ? 'opacity-55' : undefined}>
      <td className="p-2.5 lg:pl-5">
        <input value={name} onChange={(event) => setName(event.target.value)} className="w-full rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm font-medium text-foreground outline-none focus:ring-2 focus:ring-ring" />
      </td>
      <td className="p-2.5">
        <input value={category} onChange={(event) => setCategory(event.target.value)} className="w-full rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring" />
      </td>
      <td className="p-2.5">
        <input min="0" step="0.01" type="number" value={price} onChange={(event) => setPrice(event.target.value)} className="w-full rounded-lg border border-border bg-surface-raised px-3 py-2 text-right text-sm tabular-nums text-foreground outline-none focus:ring-2 focus:ring-ring" />
      </td>
      <td className="p-2.5">
        <ProductColorSelect value={colorKey} onChange={setColorKey} label={`Color for ${product.name}`} />
      </td>
      <td className="px-4 py-2.5 text-right lg:pr-5">
        <div className="flex justify-end gap-2">
          {changed && (
            <button
              type="button"
              disabled={pending || !name.trim() || !category.trim() || !Number.isFinite(Number(price)) || Number(price) < 0}
              onClick={() => onSave(product.id, { name, category, unit_price: Number(price), color_key: colorKey })}
              className="rounded-lg border border-primary/30 bg-primary-subtle px-3 py-1.5 text-xs font-semibold text-primary disabled:opacity-40"
            >
              Save
            </button>
          )}
          <button
            type="button"
            disabled={pending}
            onClick={() => onSave(product.id, { active: !product.active })}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold ${product.active ? 'bg-success-subtle text-success' : 'bg-surface-raised text-foreground-subtle'}`}
          >
            {product.active ? 'Active' : 'Archived'}
          </button>
        </div>
      </td>
    </tr>
  );
}

export function FriendsFamilyOrdersClient({
  initialWorkspace,
  isAdmin,
}: {
  initialWorkspace: FriendsFamilyWorkspace;
  isAdmin: boolean;
}) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [showNewOrder, setShowNewOrder] = useState(false);
  const [showProducts, setShowProducts] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [fulfillmentFilter, setFulfillmentFilter] = useState<'all' | FriendsFamilyFulfillmentStatus>('all');
  const [paymentFilter, setPaymentFilter] = useState<'all' | FriendsFamilyPaymentStatus>('all');

  const refresh = async () => setWorkspace(await getFriendsFamilyWorkspace());
  const filteredOrders = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    return workspace.orders.filter((order) => {
      const matchesSearch = !query || [order.order_number, order.customer_name, order.ordered_by]
        .some((value) => value.toLowerCase().includes(query));
      return matchesSearch
        && (fulfillmentFilter === 'all' || order.fulfillment_status === fulfillmentFilter)
        && (paymentFilter === 'all' || order.payment_status === paymentFilter);
    });
  }, [fulfillmentFilter, paymentFilter, searchTerm, workspace.orders]);

  return (
    <main className="flex w-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-background px-3 py-4 lg:p-6">
      <div className="mx-auto w-full min-w-0 max-w-7xl space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-foreground lg:text-2xl">Friends &amp; Family Orders</h1>
            <p className="mt-1 text-sm text-foreground-muted">
              Submit internal orders and track payment and fulfillment in one place.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/friends-family-order-form"
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3.5 py-2 text-sm font-semibold text-foreground hover:bg-surface-raised"
            >
              <ExternalLink className="size-4" /> Order form page
            </Link>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setShowProducts((current) => !current)}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3.5 py-2 text-sm font-semibold text-foreground hover:bg-surface-raised"
              >
                <Settings2 className="size-4" /> Manage products
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowNewOrder(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary-hover"
            >
              <PackagePlus className="size-4" /> New order
            </button>
          </div>
        </div>

        {showProducts && isAdmin && (
          <ProductManager products={workspace.products} onChanged={refresh} onClose={() => setShowProducts(false)} />
        )}

        {showNewOrder && (
          <FriendsFamilyOrderForm
            products={workspace.products}
            onCancel={() => setShowNewOrder(false)}
            onSaved={async () => {
              await refresh();
              setShowNewOrder(false);
            }}
          />
        )}

        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-foreground-subtle">
              Orders ({workspace.orders.length})
            </h2>
            <div className="flex flex-1 flex-wrap justify-end gap-2 sm:flex-none">
              <label className="relative min-w-52 flex-1 sm:w-64 sm:flex-none">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" />
                <span className="sr-only">Search orders</span>
                <input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Search orders" className="w-full rounded-lg border border-border bg-surface px-3 py-2 pl-9 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring" />
              </label>
              <select aria-label="Filter by order status" value={fulfillmentFilter} onChange={(event) => setFulfillmentFilter(event.target.value as 'all' | FriendsFamilyFulfillmentStatus)} className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring">
                <option value="all">All order statuses</option>
                {Object.entries(FULFILLMENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <select aria-label="Filter by payment status" value={paymentFilter} onChange={(event) => setPaymentFilter(event.target.value as 'all' | FriendsFamilyPaymentStatus)} className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring">
                <option value="all">All payment statuses</option>
                {Object.entries(PAYMENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
          </div>
          {workspace.orders.length === 0 ? (
            <div className="rounded-xl border border-border bg-surface px-6 py-14 text-center">
              <PackagePlus className="mx-auto size-10 text-foreground-subtle" />
              <h2 className="mt-3 text-lg font-semibold text-foreground">No Friends &amp; Family orders yet</h2>
              <p className="mt-1 text-sm text-foreground-muted">Create the first order to start the list.</p>
            </div>
          ) : filteredOrders.length === 0 ? (
            <div className="rounded-xl border border-border bg-surface px-6 py-10 text-center text-sm text-foreground-muted">
              No orders match the current search and filters.
            </div>
          ) : (
            filteredOrders.map((order) => <OrderCard key={order.id} order={order} products={workspace.products} onChanged={refresh} />)
          )}
        </section>
      </div>
    </main>
  );
}
