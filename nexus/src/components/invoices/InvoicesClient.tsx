'use client';

import { useMemo, useState, useTransition, type FormEvent, type ReactNode } from 'react';
import {
  assignInvoiceToOrderItems,
  createInvoice,
  deleteInvoice,
  getInvoiceWorkspaceData,
  updateInvoice,
  updateInvoiceOrderItemQuantity,
  unassignInvoiceFromOrderItem,
  type InvoiceInput,
} from '@/app/actions/invoices';
import { updateOrderItem } from '@/app/actions/orders';
import { UserAccess } from '@/lib/auth/permissions';
import { calculateOverrunPercent } from '@/lib/orderItemQuantityDefaults';
import {
  EligibleInvoiceOrderItem,
  InvoiceParty,
  InvoiceStatus,
  InvoiceWorkspaceData,
  PurchaseInvoiceWithAssignedItems,
} from '@/types/database';
import { usePropState } from '@/hooks/usePropState';

interface InvoicesClientProps {
  initialData: InvoiceWorkspaceData;
  access: UserAccess;
}

const PARTY_LABEL: Record<InvoiceParty, string> = {
  supplier: 'Supplier',
  manufacturer: 'Manufacturer',
};

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  final: 'Final',
  paid: 'Paid',
};

const EMPTY_FORM: InvoiceInput = {
  invoice_party: 'supplier',
  invoice_number: '',
  counterparty_name: '',
  invoice_date: '',
  invoice_due_date: '',
  status: 'draft',
};

function formatDate(date: string | null) {
  if (!date) return 'No date';
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatNumber(value: number | null) {
  return value === null ? '' : String(value);
}

function parseNumber(value: string) {
  const clean = value.replace(/,/g, '').trim();
  if (!clean) return null;
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : null;
}

function EditIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
      />
    </svg>
  );
}

function DeleteIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
      />
    </svg>
  );
}

function CloseIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function itemLabel(item: EligibleInvoiceOrderItem) {
  return [
    item.item_name?.name ?? 'Untitled item',
    item.category?.name,
    item.version || null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function groupItemsByPo(items: EligibleInvoiceOrderItem[]) {
  const groups = new Map<string, EligibleInvoiceOrderItem[]>();
  for (const item of items) {
    const existing = groups.get(item.order_number) ?? [];
    existing.push(item);
    groups.set(item.order_number, existing);
  }
  return Array.from(groups.entries()).map(([orderNumber, groupItems]) => ({
    orderNumber,
    items: groupItems,
  }));
}

function QuantityInput({
  value,
  disabled,
  onCommit,
}: {
  value: number | null;
  disabled: boolean;
  onCommit: (value: number | null) => Promise<void>;
}) {
  const [draft, setDraft] = usePropState(value, formatNumber);
  const [pending, startTransition] = useTransition();

  return (
    <input
      value={draft}
      inputMode="decimal"
      disabled={disabled || pending}
      onChange={(event) => setDraft(event.target.value.replace(/[^0-9.,-]/g, ''))}
      onBlur={() => {
        const next = parseNumber(draft);
        if (next === value) return;
        startTransition(async () => {
          await onCommit(next);
        });
      }}
      className="w-20 rounded border border-border bg-surface px-2 py-1 text-right text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
      placeholder="—"
    />
  );
}

function InvoiceForm({
  initialValue,
  submitLabel,
  disabled,
  onSubmit,
  onCancel,
}: {
  initialValue: InvoiceInput;
  submitLabel: string;
  disabled: boolean;
  onSubmit: (value: InvoiceInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<InvoiceInput>(initialValue);
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();

  const updateDraft = <Key extends keyof InvoiceInput>(key: Key, value: InvoiceInput[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    startTransition(async () => {
      try {
        await onSubmit(draft);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Invoice save failed');
      }
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-3 md:grid-cols-6">
        <label className="space-y-1 text-xs font-medium text-foreground-muted">
          Party
          <select
            value={draft.invoice_party}
            onChange={(event) => updateDraft('invoice_party', event.target.value as InvoiceParty)}
            disabled={disabled || pending}
            className="w-full rounded border border-border bg-surface-raised px-2 py-2 text-sm text-foreground"
          >
            <option value="supplier">Supplier</option>
            <option value="manufacturer">Manufacturer</option>
          </select>
        </label>
        <label className="space-y-1 text-xs font-medium text-foreground-muted md:col-span-2">
          Invoice #
          <input
            value={draft.invoice_number}
            onChange={(event) => updateDraft('invoice_number', event.target.value)}
            disabled={disabled || pending}
            required
            className="w-full rounded border border-border bg-surface-raised px-2 py-2 text-sm text-foreground"
            placeholder="INV-1001"
          />
        </label>
        <label className="space-y-1 text-xs font-medium text-foreground-muted md:col-span-2">
          Counterparty
          <input
            value={draft.counterparty_name ?? ''}
            onChange={(event) => updateDraft('counterparty_name', event.target.value)}
            disabled={disabled || pending}
            className="w-full rounded border border-border bg-surface-raised px-2 py-2 text-sm text-foreground"
            placeholder="Supplier or manufacturer name"
          />
        </label>
        <label className="space-y-1 text-xs font-medium text-foreground-muted">
          Status
          <select
            value={draft.status ?? 'draft'}
            onChange={(event) => updateDraft('status', event.target.value as InvoiceStatus)}
            disabled={disabled || pending}
            className="w-full rounded border border-border bg-surface-raised px-2 py-2 text-sm text-foreground"
          >
            <option value="draft">Draft</option>
            <option value="final">Final</option>
            <option value="paid">Paid</option>
          </select>
        </label>
        <label className="space-y-1 text-xs font-medium text-foreground-muted">
          Invoice date
          <input
            type="date"
            value={draft.invoice_date ?? ''}
            onChange={(event) => updateDraft('invoice_date', event.target.value)}
            disabled={disabled || pending}
            className="w-full rounded border border-border bg-surface-raised px-2 py-2 text-sm text-foreground"
          />
        </label>
        <label className="space-y-1 text-xs font-medium text-foreground-muted">
          Due date
          <input
            type="date"
            value={draft.invoice_due_date ?? ''}
            onChange={(event) => updateDraft('invoice_due_date', event.target.value)}
            disabled={disabled || pending}
            className="w-full rounded border border-border bg-surface-raised px-2 py-2 text-sm text-foreground"
          />
        </label>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="rounded border border-border px-3 py-2 text-sm text-foreground hover:bg-surface-raised"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={disabled || pending}
          className="rounded bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
        >
          {pending ? 'Saving...' : submitLabel}
        </button>
      </div>
    </form>
  );
}

function InvoiceModal({
  title,
  initialValue,
  canSave,
  onSave,
  onClose,
  children,
}: {
  title: string;
  initialValue: InvoiceInput;
  canSave: boolean;
  onSave: (value: InvoiceInput) => Promise<void>;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-xl border border-border bg-surface p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-foreground-muted hover:bg-surface-raised hover:text-foreground"
            aria-label="Close invoice modal"
          >
            <CloseIcon />
          </button>
        </div>
        <InvoiceForm
          key={`${initialValue.invoice_party}-${initialValue.invoice_number}`}
          initialValue={initialValue}
          submitLabel="Save invoice"
          disabled={!canSave}
          onSubmit={onSave}
          onCancel={onClose}
        />
        {children && <div className="mt-5 border-t border-border pt-5">{children}</div>}
      </div>
    </div>
  );
}

function InvoiceItemsTable({
  invoice,
  access,
  onRefresh,
}: {
  invoice: PurchaseInvoiceWithAssignedItems;
  access: UserAccess;
  onRefresh: () => Promise<void>;
}) {
  const canEditOrderFields = access.canEditOrderItems;
  const canAssign = access.canViewInvoices && access.canAssignInvoices;
  const invQtyKey = invoice.invoice_party === 'supplier' ? 'supplier_inv_qty' : 'manufacturer_inv_qty';

  if (invoice.assigned_items.length === 0) {
    return <p className="text-xs text-foreground-subtle">No PO items assigned.</p>;
  }

  return (
    <div className="overflow-x-auto rounded border border-border">
      <table className="min-w-full divide-y divide-border text-xs">
        <thead className="bg-surface-raised text-left text-foreground-subtle uppercase tracking-wide">
          <tr>
            <th className="px-3 py-2 font-medium">PO#</th>
            <th className="px-3 py-2 font-medium">Item</th>
            <th className="px-3 py-2 text-right font-medium">Order QTY</th>
            <th className="px-3 py-2 text-right font-medium">Final QTY</th>
            <th className="px-3 py-2 text-right font-medium">Overrun %</th>
            <th className="px-3 py-2 text-right font-medium">Accept QTY</th>
            <th className="px-3 py-2 text-right font-medium">INV QTY</th>
            {canAssign && <th className="px-3 py-2 text-right font-medium">Actions</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-border bg-surface">
          {invoice.assigned_items.map((item) => {
            const overrunPercent = calculateOverrunPercent(item.order_qty, item.overrun_qty);
            return (
              <tr key={item.id}>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-foreground-muted">{item.order_number}</td>
                <td className="min-w-56 px-3 py-2 text-foreground">{itemLabel(item)}</td>
                <td className="px-3 py-2 text-right text-foreground-muted">{item.order_qty ?? '—'}</td>
                <td className="px-3 py-2 text-right">
                  <QuantityInput
                    value={item.overrun_qty}
                    disabled={!canEditOrderFields}
                    onCommit={async (value) => {
                      await updateOrderItem(item.id, { overrun_qty: value });
                      await onRefresh();
                    }}
                  />
                </td>
                <td className="px-3 py-2 text-right text-foreground-muted">
                  {overrunPercent === null ? '—' : `${overrunPercent.toFixed(1)}%`}
                </td>
                <td className="px-3 py-2 text-right">
                  <QuantityInput
                    value={item.accept_qty}
                    disabled={!canEditOrderFields}
                    onCommit={async (value) => {
                      await updateOrderItem(item.id, { accept_qty: value });
                      await onRefresh();
                    }}
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  <QuantityInput
                    value={item[invQtyKey]}
                    disabled={!canAssign}
                    onCommit={async (value) => {
                      await updateInvoiceOrderItemQuantity(item.id, invoice.invoice_party, value);
                      await onRefresh();
                    }}
                  />
                </td>
                {canAssign && (
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={async () => {
                        await unassignInvoiceFromOrderItem(item.id, invoice.invoice_party);
                        await onRefresh();
                      }}
                      className="rounded border border-border px-2 py-1 text-xs text-foreground-muted hover:border-destructive hover:text-destructive"
                    >
                      Unassign
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ItemPicker({
  invoice,
  eligibleItems,
  canAssign,
  onRefresh,
}: {
  invoice: PurchaseInvoiceWithAssignedItems;
  eligibleItems: EligibleInvoiceOrderItem[];
  canAssign: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();

  if (!canAssign) {
    return null;
  }

  const toggle = (itemId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  return (
    <div className="mt-3 rounded border border-dashed border-border bg-surface/60">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-foreground hover:bg-surface-raised"
      >
        <span>
          Assign PO items <span className="text-xs text-foreground-subtle">({eligibleItems.length} eligible)</span>
        </span>
      </button>
      {open && (
        <div className="max-h-96 overflow-y-auto border-t border-border">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface-raised px-3 py-2">
            <span className="text-xs text-foreground-muted">{selectedIds.size} selected</span>
            <button
              type="button"
              disabled={pending || selectedIds.size === 0}
              onClick={() => {
                startTransition(async () => {
                  await assignInvoiceToOrderItems([...selectedIds], invoice.id, invoice.invoice_party);
                  setSelectedIds(new Set());
                  setOpen(false);
                  await onRefresh();
                });
              }}
              className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
            >
              {pending ? 'Saving...' : 'Save'}
            </button>
          </div>
          {eligibleItems.length === 0 ? (
            <p className="px-3 py-3 text-xs text-foreground-subtle">
              No eligible unassigned PO items for this {PARTY_LABEL[invoice.invoice_party].toLowerCase()} tab.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {groupItemsByPo(eligibleItems).map((group) => (
                <div key={group.orderNumber}>
                  <div className="bg-surface-raised px-3 py-1.5 text-xs font-semibold text-foreground-muted">
                    PO# {group.orderNumber}
                  </div>
                  <div className="divide-y divide-border">
                    {group.items.map((item) => {
                      const selected = selectedIds.has(item.id);
                      return (
                        <div key={item.id} className="flex items-center justify-between gap-3 px-3 py-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm text-foreground">{itemLabel(item)}</p>
                            <p className="text-xs text-foreground-subtle">
                              Qty {item.order_qty ?? '—'} · {formatDate(item.order_date)}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => toggle(item.id)}
                            className={`shrink-0 rounded px-2 py-1 text-xs font-medium ${
                              selected
                                ? 'bg-success text-white hover:bg-success/90'
                                : 'bg-primary text-primary-foreground hover:bg-primary-hover'
                            }`}
                          >
                            {selected ? 'Assigned' : 'Assign'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function PurchaseInvoiceEditModal({
  invoice,
  eligibleItems,
  access,
  onClose,
  onRefresh,
}: {
  invoice: PurchaseInvoiceWithAssignedItems;
  eligibleItems: EligibleInvoiceOrderItem[];
  access: UserAccess;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const canAssign = access.canViewInvoices && access.canAssignInvoices;
  const initialValue: InvoiceInput = {
    invoice_party: invoice.invoice_party,
    invoice_number: invoice.invoice_number,
    counterparty_name: invoice.counterparty_name ?? '',
    invoice_date: invoice.invoice_date ?? '',
    invoice_due_date: invoice.invoice_due_date ?? '',
    status: invoice.status,
  };

  return (
    <InvoiceModal
      title={`Edit ${invoice.invoice_number}`}
      initialValue={initialValue}
      canSave={access.canEditInvoices}
      onClose={onClose}
      onSave={async (value) => {
        await updateInvoice(invoice.id, value);
        await onRefresh();
        onClose();
      }}
    >
      <InvoiceItemsTable invoice={invoice} access={access} onRefresh={onRefresh} />
      <ItemPicker invoice={invoice} eligibleItems={eligibleItems} canAssign={canAssign} onRefresh={onRefresh} />
    </InvoiceModal>
  );
}

function InvoiceCard({
  invoice,
  eligibleItems,
  access,
  onRefresh,
}: {
  invoice: PurchaseInvoiceWithAssignedItems;
  eligibleItems: EligibleInvoiceOrderItem[];
  access: UserAccess;
  onRefresh: () => Promise<void>;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();
  const canAssign = access.canViewInvoices && access.canAssignInvoices;

  const handleDelete = () => {
    if (!access.canDeleteInvoices || !confirm(`Delete draft invoice ${invoice.invoice_number}?`)) {
      return;
    }

    setError('');
    startTransition(async () => {
      try {
        await deleteInvoice(invoice.id);
        await onRefresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Delete failed');
      }
    });
  };

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-foreground">{invoice.invoice_number}</h3>
            <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary">
              {PARTY_LABEL[invoice.invoice_party]}
            </span>
            <span className="rounded-full bg-surface-raised px-2 py-0.5 text-xs font-semibold text-foreground-muted">
              {STATUS_LABEL[invoice.status]}
            </span>
          </div>
          <p className="mt-1 text-sm text-foreground-muted">
            {invoice.counterparty_name || 'No counterparty'} · Invoice {formatDate(invoice.invoice_date)} · Due{' '}
            {formatDate(invoice.invoice_due_date)}
          </p>
        </div>
        <div className="flex gap-1">
          {access.canEditInvoices && (
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="rounded p-1.5 text-foreground-subtle hover:bg-surface-raised hover:text-foreground"
              aria-label={`Edit invoice ${invoice.invoice_number}`}
              title="Edit invoice"
            >
              <EditIcon />
            </button>
          )}
          {access.canDeleteInvoices && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={pending || invoice.status !== 'draft'}
              title={invoice.status !== 'draft' ? 'Only draft invoices can be deleted' : 'Delete invoice'}
              className="rounded p-1.5 text-foreground-subtle hover:bg-destructive-subtle hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={`Delete invoice ${invoice.invoice_number}`}
            >
              <DeleteIcon />
            </button>
          )}
        </div>
      </div>
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      <div className="mt-4">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-subtle">
          Invoice items
        </h4>
        <InvoiceItemsTable invoice={invoice} access={access} onRefresh={onRefresh} />
        <ItemPicker
          invoice={invoice}
          eligibleItems={eligibleItems}
          canAssign={canAssign}
          onRefresh={onRefresh}
        />
      </div>

      {modalOpen && (
        <PurchaseInvoiceEditModal
          invoice={invoice}
          eligibleItems={eligibleItems}
          access={access}
          onClose={() => setModalOpen(false)}
          onRefresh={onRefresh}
        />
      )}
    </div>
  );
}

export function InvoicesClient({ initialData, access }: InvoicesClientProps) {
  const [activeParty, setActiveParty] = useState<InvoiceParty>('supplier');
  const [data, setData] = useState<InvoiceWorkspaceData>(initialData);
  const [createModalOpen, setCreateModalOpen] = useState(false);

  const invoices = useMemo(
    () => data.invoices.filter((invoice) => invoice.invoice_party === activeParty),
    [data.invoices, activeParty]
  );

  const refresh = async () => {
    setData(await getInvoiceWorkspaceData());
  };

  if (!access.canViewInvoices) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <div className="max-w-sm text-center">
          <h1 className="text-xl font-semibold text-foreground">Invoice access required</h1>
          <p className="mt-2 text-sm text-foreground-muted">
            Your account can’t view purchase invoices. Ask an administrator to enable invoice access.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 overflow-y-auto px-3 py-4 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-foreground lg:text-2xl">Purchase Invoices</h1>
            <p className="mt-1 text-sm text-foreground-muted">
              Track supplier and manufacturer invoices, edit invoice line items, and assign eligible PO items.
            </p>
          </div>
          {access.canCreateInvoices && (
            <button
              type="button"
              onClick={() => setCreateModalOpen(true)}
              className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
            >
              + Create Invoice
            </button>
          )}
        </div>

        <section className="space-y-4">
          <div className="flex rounded-lg border border-border bg-surface p-1">
            {(['supplier', 'manufacturer'] as InvoiceParty[]).map((party) => (
              <button
                key={party}
                type="button"
                onClick={() => setActiveParty(party)}
                className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  activeParty === party
                    ? 'bg-primary text-primary-foreground'
                    : 'text-foreground-muted hover:bg-surface-raised hover:text-foreground'
                }`}
              >
                {PARTY_LABEL[party]} invoices
              </button>
            ))}
          </div>

          {invoices.length === 0 ? (
            <div className="rounded-lg border border-border bg-surface p-10 text-center">
              <h2 className="text-lg font-semibold text-foreground">No {PARTY_LABEL[activeParty].toLowerCase()} invoices yet</h2>
              <p className="mt-2 text-sm text-foreground-muted">
                Create an invoice record to start assigning PO items.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {invoices.map((invoice) => (
                <InvoiceCard
                  key={invoice.id}
                  invoice={invoice}
                  eligibleItems={data.eligible_items[invoice.invoice_party]}
                  access={access}
                  onRefresh={refresh}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {createModalOpen && (
        <InvoiceModal
          title="Create invoice"
          initialValue={{ ...EMPTY_FORM, invoice_party: activeParty }}
          canSave={access.canCreateInvoices}
          onClose={() => setCreateModalOpen(false)}
          onSave={async (value) => {
            await createInvoice(value);
            setCreateModalOpen(false);
            await refresh();
          }}
        >
          <p className="text-sm text-foreground-muted">
            Save the invoice first, then use its invoice card to add PO items.
          </p>
        </InvoiceModal>
      )}
    </main>
  );
}
