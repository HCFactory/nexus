'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { UserAccess } from '@/lib/auth/permissions';
import { deleteOrderItem, updateOrderItem } from '@/app/actions/orders';
import {
  assignInvoiceToOrderItem,
  createInvoice,
  getInvoiceWorkspaceData,
  unassignInvoiceFromOrderItem,
} from '@/app/actions/invoices';
import { PurchaseInvoiceEditModal } from '@/components/invoices/InvoicesClient';
import { ItemStatusDropdown } from '@/components/packaging/ItemStatusDropdown';
import { VersionCombobox } from '@/components/packaging/VersionCombobox';
import { ITEM_STATUS_CONFIG } from '@/lib/itemStatus';
import { getAnchoredDropdownPosition } from '@/lib/dropdownPosition';
import { cn } from '@/lib/utils';
import {
  Category,
  InvoiceOption,
  InvoiceParty,
  EligibleInvoiceOrderItem,
  ItemName,
  ItemStatus,
  OrderItemInvoicePatch,
  OrderItemWithDetails,
  PackagingItemCombo,
  PurchaseInvoice,
  PurchaseInvoiceWithAssignedItems,
} from '@/types/database';
import { ItemOrderStatusDropdown } from './ItemOrderStatusDropdown';
import { PackagingItemCombobox } from './PackagingItemCombobox';
import { PriorityDropdown } from './PriorityDropdown';
import { calculateOverrunPercent } from '@/lib/orderItemQuantityDefaults';
import { usePropState } from '@/hooks/usePropState';

interface VersionWithStatus {
  version: string;
  status?: string;
}

interface OrderItemRowProps {
  access: UserAccess;
  orderItem: OrderItemWithDetails;
  itemNames: ItemName[];
  categories: Category[];
  packagingItemCombos: PackagingItemCombo[];
  invoiceOptions: InvoiceOption[];
  onInvoiceOptionsChange: (options: InvoiceOption[]) => void;
  artworkStatus?: string;
  packagingItemId?: string;
  packagingItemStatus?: string;
  approvalColumnWidth?: string;
  onOpenArtwork: (orderItem: OrderItemWithDetails) => void;
  onDelete: (id: string) => void;
  onChange: (updated: OrderItemWithDetails) => void;
  onInvoicePatch: (patch: OrderItemInvoicePatch) => void;
  onCreateItemName: (name: string) => Promise<ItemName>;
  onUpdateItemName: (id: string, name: string) => Promise<ItemName>;
  onCreateCategory: (prefillName?: string, onCreated?: (category: Category) => void) => void;
  onEditCategory?: (category: Category) => void;
  onCreatePackagingItemCombo: (itemNameId: string, categoryId: string) => Promise<PackagingItemCombo>;
  onUpdatePackagingItemStatus?: (itemId: string, status: ItemStatus) => Promise<void>;
  onCreatePackagingItem?: (itemNameId: string, categoryId: string, version: string) => Promise<void>;
}

function invoiceLabel(invoice: InvoiceOption | undefined) {
  if (!invoice) return '—';
  return [invoice.invoice_number, invoice.counterparty_name].filter(Boolean).join(' · ');
}

function invoiceFieldLabel(invoice: InvoiceOption | undefined) {
  return invoice?.invoice_number ?? '—';
}

function EditIcon({ className = 'h-3.5 w-3.5' }: { className?: string }) {
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

function formatQuantity(value: number | null) {
  return value === null ? '' : value.toLocaleString();
}

function posToDigitIndex(str: string, pos: number) {
  let digits = 0;
  for (let i = 0; i < pos; i++) {
    if (str[i] !== ',') digits++;
  }
  return digits;
}

function digitIndexToPos(str: string, digitIdx: number) {
  let digits = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] !== ',') {
      if (digits === digitIdx) return i;
      digits++;
    }
  }
  return str.length;
}

function toInvoiceOption(invoice: PurchaseInvoice): InvoiceOption {
  return {
    id: invoice.id,
    invoice_party: invoice.invoice_party,
    invoice_number: invoice.invoice_number,
    counterparty_name: invoice.counterparty_name,
    status: invoice.status,
    invoice_date: invoice.invoice_date,
    invoice_due_date: invoice.invoice_due_date,
    created_at: invoice.created_at,
  };
}

function sortInvoiceOptionsNewestFirst(options: InvoiceOption[]) {
  return [...options].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function CompactQuantityInput({
  value,
  disabled,
  className = 'po-col-qty',
  inputClassName,
  onCommit,
}: {
  value: number | null;
  disabled: boolean;
  className?: string;
  inputClassName?: string;
  onCommit: (value: number | null) => Promise<void>;
}) {
  const [draft, setDraft] = usePropState(value, formatQuantity);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cursorRef = useRef<number | null>(null);

  useEffect(() => {
    if (cursorRef.current !== null && inputRef.current && document.activeElement === inputRef.current) {
      const pos = cursorRef.current;
      inputRef.current.setSelectionRange(pos, pos);
      cursorRef.current = null;
    }
  }, [draft]);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newRaw = event.target.value.replace(/[^0-9]/g, '');
    const formatted = newRaw ? parseInt(newRaw).toLocaleString() : '';
    const cursorInNew = event.target.selectionStart ?? 0;
    const digitsBeforeCursor = posToDigitIndex(event.target.value, cursorInNew);
    cursorRef.current = digitIndexToPos(formatted, digitsBeforeCursor);
    setDraft(formatted);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.currentTarget.blur();
      return;
    }

    const input = event.currentTarget;
    const pos = input.selectionStart ?? 0;

    if (event.key === 'ArrowLeft' && pos > 0 && draft[pos - 1] === ',') {
      event.preventDefault();
      input.setSelectionRange(pos - 1, pos - 1);
      return;
    }
    if (event.key === 'ArrowRight' && pos < draft.length && draft[pos] === ',') {
      event.preventDefault();
      input.setSelectionRange(pos + 1, pos + 1);
      return;
    }

    if (event.key === 'Backspace' && pos > 0 && draft[pos - 1] === ',') {
      event.preventDefault();
      const digitIdx = posToDigitIndex(draft, pos - 1);
      const raw = draft.replace(/[^0-9]/g, '');
      const newRaw = raw.slice(0, digitIdx - 1) + raw.slice(digitIdx);
      const formatted = newRaw ? parseInt(newRaw).toLocaleString() : '';
      cursorRef.current = digitIndexToPos(formatted, digitIdx - 1);
      setDraft(formatted);
      return;
    }

    if (event.key === 'Delete' && pos < draft.length && draft[pos] === ',') {
      event.preventDefault();
      const digitIdx = posToDigitIndex(draft, pos);
      const raw = draft.replace(/[^0-9]/g, '');
      const newRaw = raw.slice(0, digitIdx) + raw.slice(digitIdx + 1);
      const formatted = newRaw ? parseInt(newRaw).toLocaleString() : '';
      cursorRef.current = digitIndexToPos(formatted, digitIdx);
      setDraft(formatted);
    }
  };

  const handleCommit = async () => {
    const raw = draft.replace(/[^0-9]/g, '');
    const next = raw ? parseInt(raw) : null;
    if (next === value) return;
    setPending(true);
    try {
      await onCommit(next);
    } finally {
      setPending(false);
    }
  };

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="numeric"
      value={draft}
      onChange={handleChange}
      onBlur={handleCommit}
      onKeyDown={handleKeyDown}
      placeholder="—"
      readOnly={disabled}
      disabled={pending}
      className={cn(
        className,
        'po-gap shrink-0 border border-border rounded text-xs bg-surface text-foreground focus:outline-none focus:ring-1 focus:ring-ring text-right read-only:cursor-default read-only:opacity-70 disabled:opacity-50',
        inputClassName
      )}
    />
  );
}

function OverrunAcceptedToggle({
  accepted,
  disabled,
  onToggle,
}: {
  accepted: boolean;
  disabled: boolean;
  onToggle: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);

  const handleClick = async () => {
    if (disabled || pending) return;

    setPending(true);
    try {
      await onToggle();
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="po-col-overrun-accepted po-overrun-accepted-col flex shrink-0 justify-center">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled || pending}
        aria-pressed={accepted}
        className={cn(
          'po-overrun-accepted-toggle inline-flex shrink-0 justify-center rounded-full border px-2 py-0.5 text-center text-[11px] font-medium transition-colors',
          accepted
            ? 'border-green-500/30 bg-green-500/15 text-green-700 hover:bg-green-500/25 dark:text-green-300'
            : 'border-amber-500/30 bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 dark:text-amber-300',
          disabled || pending ? 'cursor-default opacity-50' : 'cursor-pointer'
        )}
      >
        {accepted ? 'Accepted' : 'Pending'}
      </button>
    </div>
  );
}

function InvoiceAssignmentCell({
  party,
  orderItem,
  access,
  invoiceOptions,
  onInvoicePatch,
  onInvoiceOptionsChange,
}: {
  party: InvoiceParty;
  orderItem: OrderItemWithDetails;
  access: UserAccess;
  invoiceOptions: InvoiceOption[];
  onInvoicePatch: (patch: OrderItemInvoicePatch) => void;
  onInvoiceOptionsChange: (options: InvoiceOption[]) => void;
}) {
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [editingInvoice, setEditingInvoice] = useState<PurchaseInvoiceWithAssignedItems | null>(null);
  const [editingEligibleItems, setEditingEligibleItems] = useState<EligibleInvoiceOrderItem[]>([]);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0, width: 192, maxHeight: 320 });
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const invoiceId =
    party === 'supplier' ? orderItem.supplier_invoice_id : orderItem.manufacturer_invoice_id;
  const [optimisticInvoiceId, setOptimisticInvoiceId] = usePropState<string | null>(invoiceId);
  const partyOptions = sortInvoiceOptionsNewestFirst(
    invoiceOptions.filter((option) => option.invoice_party === party)
  );
  const selectedInvoice = partyOptions.find((option) => option.id === optimisticInvoiceId);
  const canAssign = access.canViewInvoices && access.canAssignInvoices;
  const filteredOptions = partyOptions.filter((option) =>
    invoiceLabel(option).toLowerCase().includes(search.toLowerCase())
  );
  const showCreate =
    search.trim().length > 0 &&
    !partyOptions.some((option) => option.invoice_number.toLowerCase() === search.trim().toLowerCase());

  const updatePosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!buttonRef.current || !rect) return;

    setDropdownPosition(getAnchoredDropdownPosition(buttonRef.current, { minWidth: 192, maxHeight: 320 }));
  }, []);

  useEffect(() => {
    if (!open) return;

    updatePosition();

    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        (!dropdownRef.current || !dropdownRef.current.contains(target))
      ) {
        setOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [open, updatePosition]);

  if (!access.canViewInvoices) {
    return null;
  }

  if (!canAssign) {
    return (
      <div
        className="po-col-invoice po-gap shrink-0 truncate rounded border border-border bg-surface px-2 py-1 text-xs text-foreground-muted"
        title={invoiceLabel(selectedInvoice)}
      >
        {invoiceFieldLabel(selectedInvoice)}
      </div>
    );
  }

  const assign = async (nextInvoiceId: string | null) => {
    const previousInvoiceId = optimisticInvoiceId;
    setOptimisticInvoiceId(nextInvoiceId);
    setOpen(false);
    setSearch('');
    setPending(true);
    try {
      const patch = nextInvoiceId
        ? await assignInvoiceToOrderItem(orderItem.id, nextInvoiceId, party)
        : await unassignInvoiceFromOrderItem(orderItem.id, party);
      onInvoicePatch(patch);
    } catch (error) {
      setOptimisticInvoiceId(previousInvoiceId);
      console.error('Failed to update invoice assignment:', error);
      alert(error instanceof Error ? error.message : 'Failed to update invoice assignment');
    } finally {
      setPending(false);
    }
  };

  const loadInvoiceEditor = async (invoiceIdToOpen: string) => {
    setPending(true);
    try {
      const workspace = await getInvoiceWorkspaceData();
      onInvoiceOptionsChange(sortInvoiceOptionsNewestFirst(workspace.invoices.map(toInvoiceOption)));
      const invoice = workspace.invoices.find((item) => item.id === invoiceIdToOpen);
      if (!invoice) {
        throw new Error('Invoice record was not found');
      }
      setEditingInvoice(invoice);
      setEditingEligibleItems(workspace.eligible_items[invoice.invoice_party]);
      setOpen(false);
      setSearch('');
    } catch (error) {
      console.error('Failed to load invoice editor:', error);
      alert(error instanceof Error ? error.message : 'Failed to load invoice editor');
    } finally {
      setPending(false);
    }
  };

  const refreshEditingInvoice = async () => {
    if (!editingInvoice) return;
    const workspace = await getInvoiceWorkspaceData();
    onInvoiceOptionsChange(sortInvoiceOptionsNewestFirst(workspace.invoices.map(toInvoiceOption)));
    const invoice = workspace.invoices.find((item) => item.id === editingInvoice.id);
    if (!invoice) {
      setEditingInvoice(null);
      setEditingEligibleItems([]);
      return;
    }
    setEditingInvoice(invoice);
    setEditingEligibleItems(workspace.eligible_items[invoice.invoice_party]);
  };

  const createAndAssign = async () => {
    const invoiceNumber = search.trim();
    if (!invoiceNumber) return;
    setPending(true);
    try {
      const invoice = await createInvoice({
        invoice_party: party,
        invoice_number: invoiceNumber,
      });
      const option = toInvoiceOption(invoice);
      onInvoiceOptionsChange(sortInvoiceOptionsNewestFirst([...invoiceOptions, option]));
      const patch = await assignInvoiceToOrderItem(orderItem.id, option.id, party);
      onInvoicePatch(patch);
      setOpen(false);
      setSearch('');
    } catch (error) {
      console.error('Failed to create invoice:', error);
      alert(error instanceof Error ? error.message : 'Failed to create invoice');
    } finally {
      setPending(false);
    }
  };

  return (
    <div ref={containerRef} className="po-col-invoice po-gap relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        disabled={pending}
        onClick={() => {
          if (!open) updatePosition();
          setOpen((value) => !value);
          setSearch('');
        }}
        className="w-full truncate rounded border border-border bg-surface px-2 py-1 text-left text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        title={invoiceLabel(selectedInvoice)}
      >
        {invoiceFieldLabel(selectedInvoice)}
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={dropdownRef}
          className="fixed flex flex-col overflow-hidden rounded-lg border border-border bg-surface-overlay p-2 shadow-lg"
          style={{
            top: dropdownPosition.top,
            left: dropdownPosition.left,
            width: dropdownPosition.width,
            maxHeight: dropdownPosition.maxHeight,
            zIndex: 10000,
          }}
        >
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            autoFocus
            placeholder={`Search ${party} invoices`}
            className="mb-2 w-full rounded border border-border bg-surface px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <button
              type="button"
              onClick={() => assign(null)}
              className="block w-full rounded px-2 py-1.5 text-left text-xs text-foreground-muted hover:bg-surface-raised"
            >
              No invoice
            </button>
            {filteredOptions.map((option) => (
              <div key={option.id} className="group flex items-center gap-1 rounded hover:bg-surface-raised">
                <button
                  type="button"
                  onClick={() => assign(option.id)}
                  className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs text-foreground"
                >
                  {invoiceLabel(option)}
                </button>
                <button
                  type="button"
                  onClick={() => loadInvoiceEditor(option.id)}
                  className="rounded px-1 text-foreground-muted opacity-0 hover:text-foreground group-hover:opacity-100"
                  title="Edit invoice"
                  aria-label={`Edit invoice ${option.invoice_number}`}
                >
                  <EditIcon />
                </button>
              </div>
            ))}
            {showCreate && (
              <button
                type="button"
                onClick={createAndAssign}
                className="mt-1 block w-full rounded border border-dashed border-border px-2 py-1.5 text-left text-xs text-primary hover:bg-primary-subtle"
              >
                + Create “{search.trim()}”
              </button>
            )}
          </div>
        </div>,
        document.body
      )}
      {editingInvoice && (
        <PurchaseInvoiceEditModal
          invoice={editingInvoice}
          eligibleItems={editingEligibleItems}
          access={access}
          onClose={() => setEditingInvoice(null)}
          onRefresh={refreshEditingInvoice}
        />
      )}
    </div>
  );
}

function disableWrapper(disabled: boolean) {
  return disabled ? 'pointer-events-none opacity-60' : '';
}

export function OrderItemRow({
  access,
  orderItem,
  itemNames,
  categories,
  packagingItemCombos,
  invoiceOptions,
  onInvoiceOptionsChange,
  packagingItemId,
  packagingItemStatus,
  approvalColumnWidth,
  onOpenArtwork,
  onDelete,
  onChange,
  onInvoicePatch,
  onCreateItemName,
  onUpdateItemName,
  onCreateCategory,
  onEditCategory,
  onCreatePackagingItemCombo,
  onUpdatePackagingItemStatus,
  onCreatePackagingItem,
}: OrderItemRowProps) {
  const [versions, setVersions] = useState<VersionWithStatus[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [localNotesOverride, setLocalNotesOverride] = useState<string | null>(null);
  const [localQtyOverride, setLocalQtyOverride] = useState<string | null>(null);
  const [localApprovalStatusOverride, setLocalApprovalStatusOverride] = useState<{
    sourceKey: string;
    status: ItemStatus;
  } | null>(null);
  const notesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qtyInputRef = useRef<HTMLInputElement>(null);
  const qtyCursorRef = useRef<number | null>(null);
  const prevVersionKey = useRef<string | null>(null);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: orderItem.id });

  const canEditOrderFields = access.canEditOrderItemDetails;
  const canViewArtworkFields = access.canViewArtworkFields;
  const canEditArtworkFields = access.canEditArtworkFields;
  const canOpenArtworkModal = access.canOpenArtworkModal;
  const canDeleteOrderItems = access.canDeleteOrderItems;

  const localNotes = localNotesOverride ?? (orderItem.notes ?? '');
  const localQty = localQtyOverride ?? (orderItem.order_qty ? orderItem.order_qty.toLocaleString() : '');
  const effectiveItemNameId = orderItem.item_name_id;
  const effectiveCategoryId = orderItem.category_id;

  const shouldFetchVersions = Boolean(effectiveItemNameId && effectiveCategoryId);
  const versionKey = shouldFetchVersions ? `${effectiveItemNameId}-${effectiveCategoryId}` : null;

  if (versionKey !== prevVersionKey.current) {
    if (!versionKey && versions.length > 0) {
      setVersions([]);
    }
    prevVersionKey.current = versionKey;
  }

  useEffect(() => {
    if (!effectiveItemNameId || !effectiveCategoryId) return;

    let cancelled = false;
    const controller = new AbortController();

    async function loadVersions() {
      const params = new URLSearchParams({
        itemNameId: effectiveItemNameId!,
        categoryId: effectiveCategoryId!,
      });
      const response = await fetch(`/api/order-item-versions?${params.toString()}`, {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Failed to load versions (${response.status})`);
      }

      const { versions: nextVersions } = (await response.json()) as { versions: VersionWithStatus[] };

      if (!cancelled) {
        setVersions(nextVersions);
      }
    }

    loadVersions().catch((error) => {
      if (!cancelled && error?.name !== 'AbortError') {
        console.error('Failed to load order item versions:', error);
      }
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [effectiveItemNameId, effectiveCategoryId]);

  const update = useCallback(
    async (patch: Partial<OrderItemWithDetails>) => {
      const updated = await updateOrderItem(orderItem.id, patch);
      onChange(updated);
    },
    [orderItem.id, onChange]
  );

  const handleNotesChange = (value: string) => {
    if (!canEditOrderFields) return;

    setLocalNotesOverride(value);
    if (notesTimerRef.current) clearTimeout(notesTimerRef.current);
    notesTimerRef.current = setTimeout(() => {
      update({ notes: value || null }).then(() => {
        setLocalNotesOverride(null);
      });
    }, 600);
  };

  useEffect(() => {
    if (qtyCursorRef.current !== null && qtyInputRef.current && document.activeElement === qtyInputRef.current) {
      const pos = qtyCursorRef.current;
      qtyInputRef.current.setSelectionRange(pos, pos);
      qtyCursorRef.current = null;
    }
  }, [localQty]);

  const handleQtyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!canEditOrderFields) return;

    const newRaw = e.target.value.replace(/[^0-9]/g, '');
    const formatted = newRaw ? parseInt(newRaw).toLocaleString() : '';
    const cursorInNew = e.target.selectionStart ?? 0;
    const digitsBeforeCursor = posToDigitIndex(e.target.value, cursorInNew);
    qtyCursorRef.current = digitIndexToPos(formatted, digitsBeforeCursor);

    setLocalQtyOverride(formatted);
  };

  const handleQtyKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!canEditOrderFields) return;

    if (e.key === 'Enter') {
      e.currentTarget.blur();
      return;
    }

    const input = e.currentTarget;
    const pos = input.selectionStart ?? 0;

    if (e.key === 'ArrowLeft' && pos > 0 && localQty[pos - 1] === ',') {
      e.preventDefault();
      input.setSelectionRange(pos - 1, pos - 1);
      return;
    }
    if (e.key === 'ArrowRight' && pos < localQty.length && localQty[pos] === ',') {
      e.preventDefault();
      input.setSelectionRange(pos + 1, pos + 1);
      return;
    }

    if (e.key === 'Backspace' && pos > 0 && localQty[pos - 1] === ',') {
      e.preventDefault();
      const digitIdx = posToDigitIndex(localQty, pos - 1);
      const raw = localQty.replace(/[^0-9]/g, '');
      const newRaw = raw.slice(0, digitIdx - 1) + raw.slice(digitIdx);
      const formatted = newRaw ? parseInt(newRaw).toLocaleString() : '';
      qtyCursorRef.current = digitIndexToPos(formatted, digitIdx - 1);
      setLocalQtyOverride(formatted);
      return;
    }

    if (e.key === 'Delete' && pos < localQty.length && localQty[pos] === ',') {
      e.preventDefault();
      const digitIdx = posToDigitIndex(localQty, pos);
      const raw = localQty.replace(/[^0-9]/g, '');
      const newRaw = raw.slice(0, digitIdx) + raw.slice(digitIdx + 1);
      const formatted = newRaw ? parseInt(newRaw).toLocaleString() : '';
      qtyCursorRef.current = digitIndexToPos(formatted, digitIdx);
      setLocalQtyOverride(formatted);
    }
  };

  const handleQtyCommit = () => {
    if (!canEditOrderFields) return;

    const raw = localQty.replace(/[^0-9]/g, '');
    const newVal = raw ? parseInt(raw) : null;
    if (newVal !== orderItem.order_qty) {
      update({ order_qty: newVal }).then(() => {
        setLocalQtyOverride(null);
      });
    } else {
      setLocalQtyOverride(null);
    }
  };

  const handleDelete = async () => {
    if (!canDeleteOrderItems) return;
    if (!confirm('Remove this item from the order?')) return;
    setDeleting(true);
    await deleteOrderItem(orderItem.id);
    onDelete(orderItem.id);
  };

  const approvalSourceKey = `${orderItem.id}|${packagingItemStatus ?? ''}|${orderItem.approval_status ?? ''}`;
  const effectiveApprovalStatus =
    localApprovalStatusOverride?.sourceKey === approvalSourceKey
      ? localApprovalStatusOverride.status
      : (packagingItemStatus as ItemStatus) ?? orderItem.approval_status ?? 'new';
  const approvalConfig = ITEM_STATUS_CONFIG[effectiveApprovalStatus];
  const artBtnColor = approvalConfig
    ? `${approvalConfig.bg} ${approvalConfig.text} ${approvalConfig.border}`
    : 'bg-gray-100 text-gray-400 border-gray-200';

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    position: isDragging ? ('relative' as const) : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`po-table-row group flex items-center w-max min-w-full border-b border-border last:border-0 text-xs bg-surface-raised ${
        isDragging ? 'shadow-lg rounded-lg border border-primary z-10' : ''
      } ${deleting ? 'opacity-50 pointer-events-none' : ''}`}
    >
      <span
        {...(canEditOrderFields ? attributes : {})}
        {...(canEditOrderFields ? listeners : {})}
        className={`po-col-handle shrink-0 flex items-center justify-center ${
          canEditOrderFields
            ? 'cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity text-foreground-subtle hover:text-foreground-muted'
            : 'opacity-0'
        }`}
      >
        ⠿
      </span>

      <div className={`po-col-priority po-gap shrink-0 ${disableWrapper(!canEditOrderFields)}`}>
        <PriorityDropdown
          priority={orderItem.priority ?? '2_standard'}
          onPriorityChange={async (p) => {
            if (!canEditOrderFields) return;
            await update({ priority: p });
          }}
          variant="compact"
        />
      </div>

      <div className={`po-col-status po-gap shrink-0 ${disableWrapper(!canEditOrderFields)}`}>
        <ItemOrderStatusDropdown
          status={orderItem.item_order_status}
          onStatusChange={async (s) => {
            if (!canEditOrderFields) return;
            await update({ item_order_status: s });
          }}
          variant="compact"
        />
      </div>

      <div className={`po-col-item po-gap shrink-0 ${disableWrapper(!canEditOrderFields)}`}>
        <PackagingItemCombobox
          combos={packagingItemCombos}
          itemNames={itemNames}
          categories={categories}
          selectedItemNameId={orderItem.item_name_id}
          selectedCategoryId={orderItem.category_id}
          onSelect={(combo) => {
            if (!canEditOrderFields) return;
            update({
              item_name_id: combo?.item_name_id ?? null,
              category_id: combo?.category_id ?? null,
              version: null,
            });
          }}
          onCreateItemName={onCreateItemName}
          onUpdateItemName={onUpdateItemName}
          onCreateCategory={onCreateCategory}
          onEditCategory={onEditCategory}
          onCreateCombination={onCreatePackagingItemCombo}
          showDropdownEditAction
          disabled={!canEditOrderFields}
        />
      </div>

      <input
        ref={qtyInputRef}
        type="text"
        inputMode="numeric"
        value={localQty}
        onChange={handleQtyChange}
        onBlur={handleQtyCommit}
        onKeyDown={handleQtyKeyDown}
        placeholder="QTY"
        readOnly={!canEditOrderFields}
        className="po-col-qty po-gap shrink-0 border border-border rounded text-xs bg-surface text-foreground focus:outline-none focus:ring-1 focus:ring-ring text-right read-only:cursor-default read-only:opacity-70"
      />

      <CompactQuantityInput
        value={orderItem.overrun_qty}
        disabled={!canEditOrderFields}
        onCommit={async (value) => update({ overrun_qty: value })}
      />

      <div className="po-col-overrun-percent po-gap-tight shrink-0 text-right text-xs text-foreground-muted">
        {(() => {
          const percent = calculateOverrunPercent(orderItem.order_qty, orderItem.overrun_qty);
          return percent === null ? '—' : `${percent.toFixed(1)}%`;
        })()}
      </div>

      <CompactQuantityInput
        value={orderItem.accept_qty}
        disabled={!canEditOrderFields}
        inputClassName={
          orderItem.overrun_accepted
            ? 'border-green-500/30 focus:ring-green-500/30'
            : 'border-amber-500/30 focus:ring-amber-500/30'
        }
        onCommit={async (value) => update({ accept_qty: value })}
      />

      <OverrunAcceptedToggle
        accepted={orderItem.overrun_accepted}
        disabled={!canEditOrderFields}
        onToggle={async () => update({ overrun_accepted: !orderItem.overrun_accepted })}
      />

      {canViewArtworkFields && (
        <div className={`po-col-version po-gap shrink-0 ${disableWrapper(!canEditArtworkFields)}`}>
          <VersionCombobox
            versions={versions}
            selectedVersion={orderItem.version}
            onSelect={(v) => {
              if (!canEditArtworkFields) return;
              update({ version: v });
            }}
            onCreate={async (v) => {
              if (!canEditArtworkFields) return;
              await update({ version: v });
              if (effectiveItemNameId && effectiveCategoryId && onCreatePackagingItem) {
                await onCreatePackagingItem(effectiveItemNameId, effectiveCategoryId, v);
              }
            }}
            disabled={!effectiveItemNameId || !effectiveCategoryId}
            variant="compact"
          />
        </div>
      )}

      {canViewArtworkFields && (
        <div
          className={`po-gap flex shrink-0 justify-start ${disableWrapper(!canEditArtworkFields)}`}
          style={approvalColumnWidth ? { width: approvalColumnWidth, minWidth: approvalColumnWidth } : undefined}
        >
          <ItemStatusDropdown
            status={effectiveApprovalStatus}
            onStatusChange={async (s) => {
              if (!canEditArtworkFields) return;
              setLocalApprovalStatusOverride({ sourceKey: approvalSourceKey, status: s });
              if (packagingItemId && onUpdatePackagingItemStatus) {
                await onUpdatePackagingItemStatus(packagingItemId, s);
              } else {
                await update({ approval_status: s });
              }
            }}
            variant="compact"
          />
        </div>
      )}

      {canOpenArtworkModal && (
        <button
          onClick={() => onOpenArtwork(orderItem)}
          title={approvalConfig ? approvalConfig.label : 'No status'}
          className={`po-col-art po-gap shrink-0 rounded text-xs font-medium border transition-colors ${artBtnColor} hover:opacity-80`}
        >
          Art
        </button>
      )}

      <InvoiceAssignmentCell
        party="supplier"
        orderItem={orderItem}
        access={access}
        invoiceOptions={invoiceOptions}
        onInvoicePatch={onInvoicePatch}
        onInvoiceOptionsChange={onInvoiceOptionsChange}
      />

      <InvoiceAssignmentCell
        party="manufacturer"
        orderItem={orderItem}
        access={access}
        invoiceOptions={invoiceOptions}
        onInvoicePatch={onInvoicePatch}
        onInvoiceOptionsChange={onInvoiceOptionsChange}
      />

      <input
        type="text"
        value={localNotes}
        onChange={(e) => handleNotesChange(e.target.value)}
        placeholder="Notes"
        readOnly={!canEditOrderFields}
        className="po-col-notes-min po-gap flex-1 border border-border rounded text-xs bg-surface text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-ring read-only:cursor-default read-only:opacity-70"
      />

      {canDeleteOrderItems ? (
        <button
          onClick={handleDelete}
          className="po-col-handle po-gap shrink-0 text-foreground-subtle hover:text-destructive transition-colors"
          aria-label="Remove item"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      ) : (
        <span className="po-col-handle po-gap shrink-0" />
      )}
    </div>
  );
}
