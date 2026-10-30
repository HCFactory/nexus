'use client';

import { useMemo, useState, useTransition, type FormEvent } from 'react';
import {
  createFriendsFamilyOrder,
  deleteFriendsFamilyOrder,
  updateFriendsFamilyOrder,
} from '@/app/actions/friendsFamilyOrders';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { getFriendsFamilyProductColor } from '@/lib/friendsFamily/productColors';
import type { FriendsFamilyOrderWithItems, FriendsFamilyProduct } from '@/types/database';
import { Check, ImageDown, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';

type DraftLine = { key: string; productId: string; quantity: string };

function blankLine(): DraftLine {
  return { key: crypto.randomUUID(), productId: '', quantity: '' };
}

function money(value: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return fallback;
}

function downloadOrderImage({
  orderNumber,
  orderedBy,
  customerName,
  phone,
  email,
  notes,
  lines,
  total,
}: {
  orderNumber: string;
  orderedBy: string;
  customerName: string;
  phone: string;
  email: string;
  notes: string;
  lines: Array<{ product?: FriendsFamilyProduct; quantity: number; subtotal: number }>;
  total: number;
}) {
  const width = 800;
  const rowHeight = 42;
  const height = 260 + (lines.length * rowHeight) + (notes ? 58 : 0);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return;

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#166534';
  context.fillRect(0, 0, width, 12);
  context.fillStyle = '#111827';
  context.font = '700 26px Arial';
  context.fillText('Friends & Family Order', 48, 62);
  context.fillStyle = '#166534';
  context.font = '700 22px Arial';
  context.fillText(orderNumber, 610, 62);
  context.fillStyle = '#4b5563';
  context.font = '16px Arial';
  context.fillText(`Customer: ${customerName}`, 48, 100);
  context.fillText(`Ordered by: ${orderedBy}`, 48, 126);
  context.fillText([phone, email].filter(Boolean).join('  •  '), 48, 152);

  const tableTop = 180;
  context.fillStyle = '#f3f4f6';
  context.fillRect(40, tableTop, width - 80, 34);
  context.fillStyle = '#374151';
  context.font = '700 14px Arial';
  context.fillText('PRODUCT', 56, tableTop + 22);
  context.fillText('QTY', 390, tableTop + 22);
  context.fillText('UNIT PRICE', 450, tableTop + 22);
  context.fillText('SUBTOTAL', 625, tableTop + 22);

  context.font = '16px Arial';
  lines.forEach((line, index) => {
    const y = tableTop + 34 + (index * rowHeight);
    context.strokeStyle = '#e5e7eb';
    context.beginPath();
    context.moveTo(40, y + rowHeight);
    context.lineTo(width - 40, y + rowHeight);
    context.stroke();
    context.fillStyle = '#111827';
    const productLabel = line.product ? `${line.product.name} - ${line.product.category}` : 'Product';
    context.fillText(productLabel.slice(0, 39), 56, y + 27);
    context.fillText(String(line.quantity), 395, y + 27);
    context.fillText(line.product ? money(line.product.unit_price) : '—', 450, y + 27);
    context.fillText(money(line.subtotal), 625, y + 27);
  });

  const totalY = tableTop + 34 + (lines.length * rowHeight) + 34;
  context.font = '700 20px Arial';
  context.fillStyle = '#111827';
  context.fillText(`Total: ${money(total)}`, 570, totalY);
  if (notes) {
    context.font = '15px Arial';
    context.fillStyle = '#4b5563';
    context.fillText(`Notes: ${notes.slice(0, 130)}`, 48, totalY + 36);
  }

  const link = document.createElement('a');
  link.download = `${orderNumber.toLowerCase()}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

export function FriendsFamilyOrderForm({
  products,
  initialOrder = null,
  standalone = false,
  onSaved,
  onCancel,
  onDeleted,
}: {
  products: FriendsFamilyProduct[];
  initialOrder?: FriendsFamilyOrderWithItems | null;
  standalone?: boolean;
  onSaved?: () => Promise<void> | void;
  onCancel?: () => void;
  onDeleted?: () => Promise<void> | void;
}) {
  const [orderId, setOrderId] = useState<string | null>(initialOrder?.id ?? null);
  const [orderNumber, setOrderNumber] = useState<string | null>(initialOrder?.order_number ?? null);
  const [submitted, setSubmitted] = useState(false);
  const [orderedBy, setOrderedBy] = useState(initialOrder?.ordered_by ?? '');
  const [customerName, setCustomerName] = useState(initialOrder?.customer_name ?? '');
  const [phone, setPhone] = useState(initialOrder?.phone ?? '');
  const [email, setEmail] = useState(initialOrder?.email ?? '');
  const [notes, setNotes] = useState(initialOrder?.notes ?? '');
  const [lines, setLines] = useState<DraftLine[]>(
    initialOrder?.items.length
      ? initialOrder.items.map((item) => ({
          key: item.id,
          productId: item.product_id ?? '',
          quantity: String(item.quantity),
        }))
      : [blankLine()]
  );
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();
  const readOnly = standalone && submitted;

  const selectableProducts = useMemo(() => {
    const selected = new Set(lines.map((line) => line.productId));
    return products.filter((product) => product.active || selected.has(product.id));
  }, [lines, products]);

  const categories = useMemo(() => {
    const grouped = new Map<string, FriendsFamilyProduct[]>();
    for (const product of selectableProducts) {
      const category = product.category.trim() || 'Other';
      grouped.set(category, [...(grouped.get(category) ?? []), product]);
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [selectableProducts]);

  const lineDetails = lines.map((line) => {
    const product = products.find((candidate) => candidate.id === line.productId);
    const quantity = Math.max(0, Number(line.quantity) || 0);
    return { ...line, quantityText: line.quantity, product, quantity, subtotal: product ? product.unit_price * quantity : 0 };
  });
  const total = lineDetails.reduce((sum, line) => sum + line.subtotal, 0);

  const reset = () => {
    setOrderId(null);
    setOrderNumber(null);
    setSubmitted(false);
    setOrderedBy('');
    setCustomerName('');
    setPhone('');
    setEmail('');
    setNotes('');
    setLines([blankLine()]);
    setError('');
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const validLines = lineDetails.filter((line) => line.product && line.quantity > 0 && Number.isInteger(line.quantity));
    if (!orderedBy.trim() || !customerName.trim()) {
      setError('Ordered by and customer name are required.');
      return;
    }
    if (!validLines.length || validLines.length !== lines.length) {
      setError('Select a product and enter a whole-number quantity greater than zero for every line.');
      return;
    }

    startTransition(async () => {
      try {
        const input = {
          ordered_by: orderedBy,
          customer_name: customerName,
          phone,
          email,
          notes,
          items: validLines.map((line) => ({ product_id: line.productId, quantity: line.quantity })),
        };
        if (orderId) {
          await updateFriendsFamilyOrder(orderId, input);
        } else {
          const createdOrder = await createFriendsFamilyOrder(input);
          setOrderId(createdOrder.id);
          setOrderNumber(createdOrder.orderNumber);
        }
        if (standalone) setSubmitted(true);
        await onSaved?.();
      } catch (caught) {
        setError(getErrorMessage(caught, 'Order could not be saved.'));
      }
    });
  };

  const handleDelete = () => {
    if (!orderId || !window.confirm('Delete this order permanently?')) return;
    startTransition(async () => {
      try {
        await deleteFriendsFamilyOrder(orderId);
        await onDeleted?.();
      } catch (caught) {
        setError(getErrorMessage(caught, 'Order could not be deleted.'));
      }
    });
  };

  return (
    <form onSubmit={handleSubmit} className="w-full min-w-0 max-w-full overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface-raised/40 px-3 py-3 sm:px-4 lg:px-5">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-primary">
            {initialOrder ? `Editing ${initialOrder.order_number}` : 'Order form'}
          </p>
          <h2 className="mt-0.5 text-lg font-bold text-foreground">Friends &amp; Family order</h2>
        </div>
        <div className={`rounded-lg border px-3 py-2 text-xs text-foreground-subtle ${standalone && submitted ? 'border-success text-success' : 'border-dashed border-border'}`}>
          {initialOrder?.order_number ?? orderNumber ?? 'Order # assigned automatically'}
        </div>
      </div>

      <fieldset disabled={readOnly || pending} className="min-w-0 space-y-5 p-3 disabled:opacity-80 sm:p-4 lg:p-5">
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="min-w-0 space-y-1.5 text-xs font-semibold text-foreground-muted">
            Ordered by
            <input required value={orderedBy} onChange={(event) => setOrderedBy(event.target.value)} placeholder="Employee name" className="w-full min-w-0 rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm font-normal text-foreground outline-none focus:ring-2 focus:ring-ring" />
          </label>
          <label className="min-w-0 space-y-1.5 text-xs font-semibold text-foreground-muted">
            Customer Name
            <input required value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Friend or family member" className="w-full min-w-0 rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm font-normal text-foreground outline-none focus:ring-2 focus:ring-ring" />
          </label>
          <label className="min-w-0 space-y-1.5 text-xs font-semibold text-foreground-muted">
            Phone #
            <input type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="(555) 555-0123" className="w-full min-w-0 rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm font-normal text-foreground outline-none focus:ring-2 focus:ring-ring" />
          </label>
          <label className="min-w-0 space-y-1.5 text-xs font-semibold text-foreground-muted">
            Email address
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" className="w-full min-w-0 rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm font-normal text-foreground outline-none focus:ring-2 focus:ring-ring" />
          </label>
        </div>

        <section className="min-w-0">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-foreground">Line items</h3>
            <span className="text-xs text-foreground-subtle sm:hidden">Swipe table ↔</span>
          </div>
          <div className="relative w-full max-w-full touch-pan-x overflow-x-auto overscroll-x-contain rounded-lg border border-border pb-1">
            <table className="friends-family-line-items-table table-fixed text-sm" style={{ width: 534, minWidth: 534 }}>
              <colgroup>
                <col className="friends-family-product-column" style={{ width: 250 }} />
                <col className="friends-family-quantity-column" style={{ width: 80 }} />
                <col style={{ width: 80 }} />
                <col style={{ width: 80 }} />
                <col style={{ width: 44 }} />
              </colgroup>
              <thead className="border-b border-border bg-surface-raised/50 text-left text-[11px] uppercase tracking-wider text-foreground-subtle">
                <tr>
                  <th className="px-2 py-2 font-semibold">Product</th>
                  <th className="px-1 py-2 text-right font-semibold">Qty</th>
                  <th className="px-1 py-2 text-right font-semibold">Unit price</th>
                  <th className="px-1 py-2 text-right font-semibold">Subtotal</th>
                  <th className="px-1 py-2"><span className="sr-only">Remove</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {lineDetails.map((line) => {
                  const selectedColor = line.product ? getFriendsFamilyProductColor(line.product.color_key) : null;
                  return (
                  <tr key={line.key}>
                    <td className="p-2 pr-1">
                      <Select
                        value={line.productId || undefined}
                        onValueChange={(productId) => setLines((current) => current.map((candidate) => candidate.key === line.key ? { ...candidate, productId } : candidate))}
                        disabled={readOnly || pending}
                      >
                        <SelectTrigger
                          aria-label="Product"
                          className="h-9 w-full min-w-0 px-2 text-xs md:text-sm"
                          style={selectedColor ? {
                            backgroundColor: selectedColor.background,
                            borderColor: selectedColor.border,
                            color: selectedColor.foreground,
                          } : {
                            backgroundColor: '#ffffff',
                          }}
                        >
                          <SelectValue placeholder="Select a product…" />
                        </SelectTrigger>
                        <SelectContent className="max-w-[min(90vw,28rem)] md:w-56 md:max-w-56 md:[&_[data-radix-select-viewport]]:min-w-0">
                          {categories.map(([category, categoryProducts]) => (
                            <SelectGroup key={category}>
                              <SelectLabel>{category}</SelectLabel>
                              {categoryProducts.map((product) => {
                                const color = getFriendsFamilyProductColor(product.color_key);
                                return (
                                  <SelectItem
                                    key={product.id}
                                    value={product.id}
                                    className="my-0.5 border text-xs"
                                    style={{
                                      backgroundColor: color.background,
                                      borderColor: color.border,
                                      color: color.foreground,
                                    }}
                                  >
                                    {product.name} - {product.category}
                                  </SelectItem>
                                );
                              })}
                            </SelectGroup>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="p-1">
                      <input aria-label="Quantity" required min="1" step="1" type="number" value={line.quantityText} onChange={(event) => setLines((current) => current.map((candidate) => candidate.key === line.key ? { ...candidate, quantity: event.target.value } : candidate))} className="w-full rounded-lg border border-border bg-surface-raised px-1.5 py-2 text-right text-sm tabular-nums text-foreground outline-none focus:ring-2 focus:ring-ring" />
                    </td>
                    <td className="px-1 py-2 text-right tabular-nums text-foreground-muted">{line.product ? money(line.product.unit_price) : '—'}</td>
                    <td className="px-1 py-2 text-right font-semibold tabular-nums text-foreground">{money(line.subtotal)}</td>
                    <td className="p-1 text-right">
                      <button type="button" disabled={lines.length === 1 || readOnly} onClick={() => setLines((current) => current.filter((candidate) => candidate.key !== line.key))} className="rounded p-2 text-foreground-subtle hover:bg-destructive-subtle hover:text-destructive disabled:cursor-not-allowed disabled:opacity-30" aria-label="Remove line item"><Trash2 className="size-4" /></button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
              <tfoot className="border-t border-border bg-surface-raised/30">
                <tr>
                  <td colSpan={2} className="px-3 py-2">
                    {!readOnly && <button type="button" onClick={() => setLines((current) => [...current, blankLine()])} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-foreground hover:border-primary/40 hover:text-primary"><Plus className="size-3.5" /> Add line item</button>}
                  </td>
                  <td className="px-2 py-2 text-right font-semibold text-foreground-muted">Total price</td>
                  <td className="px-2 py-2 text-right text-base font-bold tabular-nums text-foreground">{money(total)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        <label className="block min-w-0 space-y-1.5 text-xs font-semibold text-foreground-muted">
          Notes
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={4} placeholder="Add pickup details, special instructions, or anything else the fulfillment team should know." className="w-full min-w-0 resize-y rounded-lg border border-border bg-surface-raised px-3 py-2.5 text-sm font-normal text-foreground outline-none focus:ring-2 focus:ring-ring" />
        </label>
      </fieldset>

      {error && <p role="alert" className="px-4 pb-3 text-sm text-destructive lg:px-5">{error}</p>}

      <div className="flex flex-wrap justify-between gap-2 border-t border-border px-4 py-3 lg:px-5">
        <div>
          {initialOrder && !standalone && (
            <button type="button" disabled={pending} onClick={handleDelete} className="inline-flex items-center gap-2 rounded-lg border border-destructive/30 px-4 py-2 text-sm font-semibold text-destructive hover:bg-destructive-subtle disabled:opacity-50"><Trash2 className="size-4" /> Delete order</button>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {standalone && submitted && (
            <>
              <button type="button" onClick={reset} className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground hover:bg-surface-raised"><RotateCcw className="size-4" /> New Order</button>
              <button type="button" onClick={() => setSubmitted(false)} className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground hover:bg-surface-raised"><Pencil className="size-4" /> Edit</button>
              <button type="button" onClick={() => downloadOrderImage({ orderNumber: orderNumber ?? 'friends-family-order', orderedBy, customerName, phone, email, notes, lines: lineDetails, total })} className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground hover:bg-surface-raised"><ImageDown className="size-4" /> Download Image</button>
              <button type="button" disabled className="inline-flex items-center gap-2 rounded-lg bg-success px-5 py-2 text-sm font-semibold text-white"><Check className="size-4" /> Submitted</button>
            </>
          )}
          {!submitted && (
            <>
              {onCancel && <button type="button" onClick={onCancel} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground-muted hover:bg-surface-raised">Cancel</button>}
              <button type="submit" disabled={pending || selectableProducts.length === 0} className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"><Check className="size-4" /> {pending ? 'Saving…' : orderId ? 'Save changes' : 'Submit order'}</button>
            </>
          )}
        </div>
      </div>
    </form>
  );
}
