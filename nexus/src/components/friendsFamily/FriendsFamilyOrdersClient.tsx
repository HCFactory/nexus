'use client';

import Link from 'next/link';
import { useState, useTransition, type FormEvent } from 'react';
import {
  createFriendsFamilyProduct,
  getFriendsFamilyWorkspace,
  updateFriendsFamilyOrderStatus,
  updateFriendsFamilyProduct,
} from '@/app/actions/friendsFamilyOrders';
import { FriendsFamilyOrderForm } from './FriendsFamilyOrderForm';
import type {
  FriendsFamilyFulfillmentStatus,
  FriendsFamilyOrderWithItems,
  FriendsFamilyPaymentStatus,
  FriendsFamilyProduct,
  FriendsFamilyWorkspace,
} from '@/types/database';
import { ChevronDown, ExternalLink, PackagePlus, Pencil, Plus, Settings2, X } from 'lucide-react';

const FULFILLMENT_LABELS: Record<FriendsFamilyFulfillmentStatus, string> = {
  new: 'New',
  processing: 'Processing',
  fulfilled: 'Fulfilled',
  cancelled: 'Cancelled',
};

const PAYMENT_LABELS: Record<FriendsFamilyPaymentStatus, string> = {
  unpaid: 'Unpaid',
  paid: 'Paid',
  refunded: 'Refunded',
};

function money(value: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function statusClass(kind: 'fulfillment' | 'payment', value: string) {
  if (value === 'fulfilled' || value === 'paid') return 'border-success/30 bg-success-subtle text-success';
  if (value === 'cancelled' || value === 'refunded') return 'border-destructive/30 bg-destructive-subtle text-destructive';
  if (kind === 'fulfillment' && value === 'processing') return 'border-warning/30 bg-warning-subtle text-warning';
  return 'border-border bg-surface-raised text-foreground-muted';
}

function StatusSelect<T extends string>({
  label,
  value,
  options,
  kind,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: Record<T, string>;
  kind: 'fulfillment' | 'payment';
  disabled: boolean;
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
        className={`appearance-none rounded-full border py-1.5 pl-3 pr-8 text-xs font-semibold outline-none transition focus:ring-2 focus:ring-ring disabled:opacity-60 ${statusClass(kind, value)}`}
      >
        {(Object.keys(options) as T[]).map((optionValue) => (
          <option key={optionValue} value={optionValue}>
            {options[optionValue]}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-3 -translate-y-1/2" />
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
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface-raised/40 px-4 py-2.5">
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
            disabled={pending}
            onChange={(fulfillment_status) => updateStatus({ fulfillment_status })}
          />
          <StatusSelect
            label={`Payment status for ${order.order_number}`}
            value={order.payment_status}
            options={PAYMENT_LABELS}
            kind="payment"
            disabled={pending}
            onChange={(payment_status) => updateStatus({ payment_status })}
          />
          <button type="button" onClick={() => setEditing(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-surface" aria-label={`Edit ${order.order_number}`}>
            <Pencil className="size-3.5" /> Edit
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
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();

  const saveNewProduct = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    startTransition(async () => {
      try {
        await createFriendsFamilyProduct({ name, category, unit_price: Number(price) });
        setName('');
        setCategory('');
        setPrice('');
        await onChanged();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Product could not be saved.');
      }
    });
  };

  const saveProduct = (
    productId: string,
    patch: Partial<Pick<FriendsFamilyProduct, 'name' | 'category' | 'unit_price' | 'active'>>
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

      <form onSubmit={saveNewProduct} className="grid gap-3 border-b border-border p-4 sm:grid-cols-[1fr_1fr_160px_auto] lg:p-5">
        <input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Product name" className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring" />
        <input required value={category} onChange={(event) => setCategory(event.target.value)} placeholder="Category" className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring" />
        <input required min="0" step="0.01" type="number" value={price} onChange={(event) => setPrice(event.target.value)} placeholder="Unit price" className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring" />
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
  onSave: (productId: string, patch: Partial<Pick<FriendsFamilyProduct, 'name' | 'category' | 'unit_price' | 'active'>>) => void;
}) {
  const [name, setName] = useState(product.name);
  const [category, setCategory] = useState(product.category);
  const [price, setPrice] = useState(String(product.unit_price));
  const changed = name.trim() !== product.name || category.trim() !== product.category || Number(price) !== product.unit_price;

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
      <td className="px-4 py-2.5 text-right lg:pr-5">
        <div className="flex justify-end gap-2">
          {changed && (
            <button
              type="button"
              disabled={pending || !name.trim() || !category.trim() || !Number.isFinite(Number(price)) || Number(price) < 0}
              onClick={() => onSave(product.id, { name, category, unit_price: Number(price) })}
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

  const refresh = async () => setWorkspace(await getFriendsFamilyWorkspace());

  return (
    <main className="flex-1 overflow-y-auto bg-background px-3 py-4 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-foreground lg:text-2xl">Friends &amp; Family Orders</h1>
            <p className="mt-1 text-sm text-foreground-muted">
              Submit internal orders and track payment and fulfillment in one place.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/friends-family/order-form"
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
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-foreground-subtle">
              Orders ({workspace.orders.length})
            </h2>
          </div>
          {workspace.orders.length === 0 ? (
            <div className="rounded-xl border border-border bg-surface px-6 py-14 text-center">
              <PackagePlus className="mx-auto size-10 text-foreground-subtle" />
              <h2 className="mt-3 text-lg font-semibold text-foreground">No Friends &amp; Family orders yet</h2>
              <p className="mt-1 text-sm text-foreground-muted">Create the first order to start the list.</p>
            </div>
          ) : (
            workspace.orders.map((order) => <OrderCard key={order.id} order={order} products={workspace.products} onChanged={refresh} />)
          )}
        </section>
      </div>
    </main>
  );
}
