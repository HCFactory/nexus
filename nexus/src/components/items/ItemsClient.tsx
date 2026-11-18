"use client";

import { FormEvent, useEffect, useId, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Boxes,
  FileSpreadsheet,
  GitCompareArrows,
  Link2Off,
  Loader2,
  Menu,
  PackageOpen,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Trash2,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  createBusinessCentralItem,
  deleteBusinessCentralItem,
  markBusinessCentralItemReadyToPush,
  saveBusinessCentralItemLocal,
  syncBusinessCentralItems,
  verifyBusinessCentralConnection,
  pushBusinessCentralItem,
} from "@/app/actions/businessCentralItems";
import { listItemTemplates } from "@/app/actions/itemTemplates";
import { templateToCreateInput } from "@/lib/businessCentral/itemTemplateMapper";
import { resolveUserAccess, ResolvedUserAccess } from "@/lib/auth/permissions";
import { cn } from "@/lib/utils";
import {
  BusinessCentralItemWithDetails,
  BusinessCentralReferenceData,
  BusinessCentralReferenceItem,
  BusinessCentralSyncEvent,
  ConnectionState,
  SyncProgressState,
  SyncStatus,
} from "@/types/businessCentralItems";
import { Category, ItemName, ItemTemplate, PackagingItemCombo, ProductLine, User } from "@/types/database";
import { Gs1ImportModal } from "@/components/gs1/Gs1ImportModal";
import { Gs1FieldsPanel } from "@/components/gs1/Gs1FieldsPanel";
import { BarcodeUploadsPanel } from "@/components/items/BarcodeUploadsPanel";
import { PurchasesPanel } from "@/components/items/PurchasesPanel";
import {
  CreateBusinessCentralItemDraft,
  EditableDetailField,
  EditableItemField,
  useBusinessCentralItemsMock,
} from "./useBusinessCentralItemsMock";

interface ItemsClientProps {
  activeConnectionId?: string | null;
  items: BusinessCentralItemWithDetails[];
  events: BusinessCentralSyncEvent[];
  connection: ConnectionState;
  syncProgress: SyncProgressState;
  references: BusinessCentralReferenceData;
  itemNames: ItemName[];
  categories: Category[];
  packagingItemCombos: PackagingItemCombo[];
  productLines?: ProductLine[];
  initialUser: User | null;
  isLoading?: boolean;
}

type BadgeVariant = React.ComponentProps<typeof Badge>["variant"];
type TabKey = "bc" | "nexus" | "retailer" | "audit" | "gs1" | "purchases";
type ActionKey = "sync" | "fullSync" | "save" | "push" | "create" | "delete" | "verify";
type ItemSortKey = "number" | "lastModified";

const SYNC_STATUS_LABEL: Record<SyncStatus, string> = {
  never_synced: "Never synced",
  synced: "Synced",
  local_dirty: "Unsaved",
  unpushed: "Unpushed",
  syncing: "Syncing…",
  failed: "Failed",
  deleted_in_bc: "Deleted in BC",
};

const SYNC_STATUS_VARIANT: Record<SyncStatus, BadgeVariant> = {
  never_synced: "outline",
  synced: "success",
  local_dirty: "warning",
  unpushed: "warning",
  syncing: "info",
  failed: "destructive",
  deleted_in_bc: "secondary",
};

const EVENT_STATUS_VARIANT: Record<string, BadgeVariant> = {
  success: "success",
  failed: "destructive",
  skipped: "secondary",
  conflict_resolved: "warning",
};

const INTEGER_DETAIL_FIELDS = new Set<EditableDetailField>([
  "unitsPerCase",
  "costcoCasesPerLayer",
  "costcoLayersPerPallet",
  "samsCasesPerLayer",
  "samsLayersPerPallet",
]);
const FIELD_CONTROL_CLASS = "bg-background dark:bg-background";

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function canEditBcFields(access: ResolvedUserAccess): boolean {
  // TODO Phase 4: replace the temporary admin gate with canEditBusinessCentralItemBcFields.
  return access.isAdmin;
}

function coerceNullableNumber(value: string): number | null {
  if (value.trim() === "") return null;
  return Number(value);
}

function isInvalidNumber(value: number | null, integer = false): boolean {
  if (value === null) return false;
  return (
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isInteger(value))
  );
}

export function ItemsClient({
  activeConnectionId,
  items,
  events,
  connection,
  syncProgress,
  references,
  itemNames,
  categories,
  packagingItemCombos,
  productLines = [],
  initialUser,
  isLoading = false,
}: ItemsClientProps) {
  const [state, dispatch] = useBusinessCentralItemsMock(items, events);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<ItemSortKey>("number");
  const [tab, setTab] = useState<TabKey>("bc");
  const [isItemsSidebarCollapsed, setIsItemsSidebarCollapsed] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [gs1ImportOpen, setGs1ImportOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<ActionKey | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  useEffect(() => {
    dispatch({ type: "resetFromServer", items, events });
  }, [dispatch, items, events, activeConnectionId]);

  const access = resolveUserAccess(initialUser);
  const canEdit = canEditBcFields(access);

  const runAction = <T,>({
    key,
    action,
    optimistic,
    onSuccess,
    successMessage,
  }: {
    key: ActionKey;
    action: () => Promise<T>;
    optimistic?: () => void;
    onSuccess?: (result: T) => void;
    successMessage: string | ((result: T) => string);
  }) => {
    setActionError(null);
    setActionSuccess(null);
    setPendingAction(key);
    optimistic?.();
    startTransition(() => {
      action()
        .then((result) => {
          onSuccess?.(result);
          setActionSuccess(
            typeof successMessage === "function"
              ? successMessage(result)
              : successMessage,
          );
          router.refresh();
        })
        .catch((error) => {
          setActionError(
            error instanceof Error
              ? error.message
              : "Business Central action failed",
          );
        })
        .finally(() => setPendingAction(null));
    });
  };

  const selectedEntry = () =>
    state.items.find(({ item }) => item.id === state.selectedId) ?? null;

  const revertUnsaved = () => {
    const entry = selectedEntry();
    if (!entry || entry.item.syncStatus !== "local_dirty") return;
    const savedEntry = items.find(({ item }) => item.id === entry.item.id);
    if (!savedEntry) return;
    setActionError(null);
    setActionSuccess(`Reverted unsaved changes for ${savedEntry.item.bcItemNumber ?? savedEntry.item.displayName}.`);
    dispatch({ type: "revertUnsavedItem", entry: savedEntry });
  };

  const saveLocal = () => {
    const entry = selectedEntry();
    if (!entry) return;
    runAction({
      key: "save",
      action: () =>
        saveBusinessCentralItemLocal({
          itemId: entry.item.id,
          item: {
            display_name: entry.item.displayName,
            display_name_2: entry.item.displayName2,
            item_category_id: entry.item.itemCategoryId,
            item_category_code: entry.item.itemCategoryCode,
            blocked: entry.item.blocked,
            gtin: entry.item.gtin,
            unit_price: entry.item.unitPrice,
            unit_cost: entry.item.unitCost,
            tax_group_id: entry.item.taxGroupId,
            tax_group_code: entry.item.taxGroupCode,
            base_unit_of_measure_id: entry.item.baseUnitOfMeasureId,
            base_unit_of_measure_code: entry.item.baseUnitOfMeasureCode,
            general_product_posting_group_id: entry.item.generalProductPostingGroupId,
            general_product_posting_group_code: entry.item.generalProductPostingGroupCode,
            inventory_posting_group_id: entry.item.inventoryPostingGroupId,
            inventory_posting_group_code: entry.item.inventoryPostingGroupCode,
            price_includes_tax: entry.item.priceIncludesTax,
          },
          details: {
            artwork_status: entry.details.artworkStatus,
            net_weight_grams: entry.details.netWeightGrams,
            sams_club_item_number: entry.details.samsClubItemNumber,
            units_per_case: entry.details.unitsPerCase,
            costco_cases_per_layer: entry.details.costcoCasesPerLayer,
            costco_layers_per_pallet: entry.details.costcoLayersPerPallet,
            sams_cases_per_layer: entry.details.samsCasesPerLayer,
            sams_layers_per_pallet: entry.details.samsLayersPerPallet,
            custom_fields: entry.details.customFields,
          },
        }).then(() => markBusinessCentralItemReadyToPush(entry.item.id)),
      optimistic: () => dispatch({ type: "saveLocal", itemId: entry.item.id }),
      successMessage: "Saved local edits. Ready to push to Business Central.",
    });
  };

  const sortedItems = useMemo(() => {
    return [...state.items].sort((a, b) => compareItems(a, b, sortKey));
  }, [state.items, sortKey]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return sortedItems;
    return sortedItems.filter(({ item }) => {
      return (
        item.displayName.toLowerCase().includes(query) ||
        (item.bcItemNumber ?? "").toLowerCase().includes(query) ||
        (item.gtin ?? "").toLowerCase().includes(query)
      );
    });
  }, [sortedItems, search]);

  const selected = useMemo(
    () => state.items.find(({ item }) => item.id === state.selectedId) ?? null,
    [state.items, state.selectedId],
  );

  const selectedEvents = useMemo(
    () => state.events.filter((event) => event.itemId === state.selectedId),
    [state.events, state.selectedId],
  );

  const hasUnsyncedLocalEdits = state.items.some(
    ({ item }) =>
      item.syncStatus === "local_dirty" ||
      item.syncStatus === "unpushed" ||
      item.syncStatus === "never_synced",
  );
  const baseCanRunSync =
    connection.kind === "configured" && !syncProgress.inProgress;
  const canRunSync = baseCanRunSync && !hasUnsyncedLocalEdits;
  const syncDisabledReason = !baseCanRunSync
    ? "Business Central must be connected and idle before syncing."
    : hasUnsyncedLocalEdits
      ? "Save and push local edits before pulling from Business Central."
      : undefined;

  return (
    <div className="flex h-[calc(100vh-3.5rem)] min-h-0 flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="mt-0.5"
            onClick={() => setIsItemsSidebarCollapsed((current) => !current)}
            aria-label={
              isItemsSidebarCollapsed
                ? "Expand items list panel"
                : "Collapse items list panel"
            }
            title={
              isItemsSidebarCollapsed
                ? "Expand items list panel"
                : "Collapse items list panel"
            }
          >
            <Menu className="size-4" />
          </Button>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Items
            </h1>
            {connection.kind !== "not_configured" && (
              <p className="mt-1 text-xs text-foreground-subtle">
                Last sync: {formatTimestamp(connection.lastPulledAt)}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canRunSync || isPending}
                  title="Pull items changed since last sync"
                  onClick={() =>
                    runAction({
                      key: "sync",
                      action: () => syncBusinessCentralItems({ full: false }),
                      successMessage: ({ imported, skipped }) =>
                        `Sync complete: imported ${imported} item${imported === 1 ? "" : "s"}${skipped ? "; more items may remain" : ""}.`,
                    })
                  }
                >
                  <RefreshCw className={cn("size-4", pendingAction === "sync" && "animate-spin")} />
                  {pendingAction === "sync" ? "Syncing…" : "Sync Now"}
                </Button>
              </span>
            </TooltipTrigger>
            {syncDisabledReason && (
              <TooltipContent>{syncDisabledReason}</TooltipContent>
            )}
          </Tooltip>
          <Button
            variant="outline"
            size="sm"
            disabled={!baseCanRunSync || isPending}
            title="Ignore last_pulled_at and re-pull everything"
            onClick={() =>
              runAction({
                key: "fullSync",
                action: () => syncBusinessCentralItems({ full: true }),
                successMessage: ({ imported, skipped }) =>
                  `Full resync complete: imported ${imported} item${imported === 1 ? "" : "s"}${skipped ? "; more items may remain" : ""}.`,
              })
            }
          >
            <RotateCw className={cn("size-4", pendingAction === "fullSync" && "animate-spin")} />
            {pendingAction === "fullSync" ? "Resyncing…" : "Full resync"}
          </Button>
          {access.canManageCatalog && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setGs1ImportOpen(true)}
              title="Import products from a GS1 Data Hub Excel export"
            >
              <FileSpreadsheet className="size-4" />
              Import GS1 Excel
            </Button>
          )}
          <Button
            size="sm"
            disabled={!canEdit || !baseCanRunSync || isPending}
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="size-4" />
            {pendingAction === "create" ? "Creating…" : "Create item"}
          </Button>
        </div>
      </header>

      {access.canManageCatalog && (
        <div className="border-b border-border px-5 py-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/item-categories">
              <Boxes className="size-4" />
              Item categories
            </Link>
          </Button>
        </div>
      )}

      <Gs1ImportModal open={gs1ImportOpen} onOpenChange={setGs1ImportOpen} />

      {actionError && (
        <div className="border-b border-border bg-destructive-subtle px-5 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}
      {actionSuccess && !actionError && (
        <div className="border-b border-border bg-success-subtle px-5 py-2 text-sm text-success">
          {actionSuccess}
        </div>
      )}

      {isLoading ? (
        <LoadingState />
      ) : connection.kind === "not_configured" ? (
        <NotConfiguredState
          onVerify={() =>
            runAction({
              key: "verify",
              action: () => verifyBusinessCentralConnection(),
              successMessage: "Business Central connection verified.",
            })
          }
          isPending={isPending}
        />
      ) : connection.kind === "error" && state.items.length === 0 ? (
        <ConnectionErrorState
          connection={connection}
          onRetry={() =>
            runAction({
              key: "verify",
              action: () => verifyBusinessCentralConnection(),
              successMessage: "Business Central connection verified.",
            })
          }
          isPending={isPending}
        />
      ) : state.items.length === 0 ? (
        <NothingSyncedState
          onSync={() =>
            runAction({
              key: "fullSync",
              action: () => syncBusinessCentralItems({ full: true }),
              successMessage: ({ imported, skipped }) =>
                `Full resync complete: imported ${imported} item${imported === 1 ? "" : "s"}${skipped ? "; more items may remain" : ""}.`,
            })
          }
          isPending={isPending}
          canSync={baseCanRunSync}
        />
      ) : (
        <div className="relative min-h-0 flex-1 overflow-hidden p-3 lg:p-4">
          <div
            className={cn(
              "grid h-full min-h-0 grid-cols-1 transition-[grid-template-columns,gap] duration-300 ease-in-out motion-reduce:transition-none",
              isItemsSidebarCollapsed
                ? "gap-0 lg:grid-cols-[minmax(0,0fr)_1fr]"
                : "gap-3 lg:grid-cols-[minmax(320px,380px)_1fr] lg:gap-4",
            )}
          >
            <div
              className={cn(
                "absolute inset-3 z-20 min-h-0 min-w-0 overflow-hidden transition-[opacity,transform] duration-300 ease-in-out motion-reduce:transition-none lg:relative lg:inset-auto lg:z-auto lg:h-full",
                isItemsSidebarCollapsed
                  ? "-translate-x-full opacity-0 pointer-events-none lg:-translate-x-2"
                  : "translate-x-0 opacity-100",
              )}
              aria-hidden={isItemsSidebarCollapsed}
            >
              <ItemsSidebar
                items={filtered}
                totalItems={state.items.length}
                sortKey={sortKey}
                onSortChange={setSortKey}
                selectedId={state.selectedId}
                onSelect={(itemId) => dispatch({ type: "selectItem", itemId })}
                search={search}
                onSearch={setSearch}
                conflictItemIds={state.conflictItemIds}
              />
            </div>
            <div className="min-h-0 overflow-hidden rounded-xl border border-border bg-surface-raised card-shadow">
              {selected ? (
                <DetailPanel
                  entry={selected}
                  events={selectedEvents}
                  references={references}
                  itemNames={itemNames}
                  categories={categories}
                  packagingItemCombos={packagingItemCombos}
                  productLines={productLines}
                  access={access}
                  tab={tab}
                  onTabChange={setTab}
                  canEdit={canEdit}
                  isPending={isPending}
                  pendingAction={pendingAction}
                  hasConflict={state.conflictItemIds.includes(selected.item.id)}
                  onEditItemField={(field, value) =>
                    dispatch({
                      type: "editItemField",
                      itemId: selected.item.id,
                      field,
                      value,
                    })
                  }
                  onEditDetailField={(field, value) =>
                    dispatch({
                      type: "editDetailField",
                      itemId: selected.item.id,
                      field,
                      value,
                    })
                  }
                  onSaveLocal={saveLocal}
                  onRevertUnsaved={revertUnsaved}
                  onPushToBc={() =>
                    runAction({
                      key: "push",
                      action: () => pushBusinessCentralItem(selected.item.id),
                      onSuccess: (entry) => dispatch({ type: "upsertCreatedItem", entry }),
                      successMessage: "Pushed item changes to Business Central.",
                    })
                  }
                  onDelete={() => setDeleteOpen(true)}
                  onSimulateBcUpdate={() =>
                    dispatch({
                      type: "simulateBcUpdate",
                      itemId: selected.item.id,
                    })
                  }
                />
              ) : (
                <div className="flex h-full items-center justify-center text-foreground-muted">
                  Select an item to view details.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <CreateItemDialog
        key={createOpen ? "open" : "closed"}
        open={createOpen}
        onOpenChange={setCreateOpen}
        references={references}
        categories={categories}
        isPending={isPending}
        pendingAction={pendingAction}
        onCreate={(draft) => {
          runAction({
            key: "create",
            action: () =>
              createBusinessCentralItem({
                displayName: draft.displayName,
                number: draft.manualNumber ? draft.bcItemNumber : undefined,
                type: draft.type,
                itemCategoryCode: draft.itemCategoryCode,
                baseUnitOfMeasureCode: draft.baseUnitOfMeasureCode,
                taxGroupCode: draft.taxGroupCode || undefined,
                unitPrice: draft.unitPrice,
                unitCost: draft.unitCost,
                gtin: draft.gtin,
                categoryId: draft.categoryId,
                generalProductPostingGroupCode: draft.generalProductPostingGroupCode || undefined,
                inventoryPostingGroupCode: draft.inventoryPostingGroupCode || undefined,
              }),
            onSuccess: (entry) => dispatch({ type: "upsertCreatedItem", entry }),
            successMessage: (entry) =>
              `Created ${entry.item.bcItemNumber ?? entry.item.displayName} in Business Central.`,
          });
        }}
      />
      {selected && (
        <DeleteItemDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          item={selected}
          isPending={isPending}
          pendingAction={pendingAction}
          onDelete={(confirmation) => {
            runAction({
              key: "delete",
              action: () => deleteBusinessCentralItem(selected.item.id, confirmation),
              optimistic: () => dispatch({ type: "deleteItem", itemId: selected.item.id }),
              successMessage: "Deleted item from Business Central and Nexus.",
            });
          }}
        />
      )}
    </div>
  );
}

function compareItems(
  a: BusinessCentralItemWithDetails,
  b: BusinessCentralItemWithDetails,
  sortKey: ItemSortKey,
): number {
  if (sortKey === "lastModified") {
    return toTimestamp(b.item.bcLastModifiedAt) - toTimestamp(a.item.bcLastModifiedAt);
  }
  return compareItemNumbers(a.item.bcItemNumber, b.item.bcItemNumber);
}

function compareItemNumbers(a: string | null, b: string | null): number {
  const left = a ?? "";
  const right = b ?? "";
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function toTimestamp(value: string | null): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function ItemsSidebar({
  items,
  totalItems,
  sortKey,
  onSortChange,
  selectedId,
  onSelect,
  search,
  onSearch,
  conflictItemIds,
}: {
  items: BusinessCentralItemWithDetails[];
  totalItems: number;
  sortKey: ItemSortKey;
  onSortChange: (sortKey: ItemSortKey) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  search: string;
  onSearch: (value: string) => void;
  conflictItemIds: string[];
}) {
  const isSearching = search.trim().length > 0;
  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface-raised card-shadow">
      <div className="border-b border-border p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" />
          <Input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search by name, number, or GTIN"
            className="pl-9 pr-9"
          />
          {search && (
            <button
              type="button"
              onClick={() => onSearch("")}
              className="absolute right-2 top-1/2 rounded-md p-1 -translate-y-1/2 text-foreground-subtle transition-colors hover:bg-surface hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        <div className="mt-3 flex items-center justify-between gap-2 text-xs text-foreground-muted">
          <span>
            {isSearching
              ? `Showing ${items.length} of ${totalItems} item${totalItems === 1 ? "" : "s"}`
              : `Showing ${totalItems} item${totalItems === 1 ? "" : "s"}`}
          </span>
        </div>
        <div className="mt-2 flex gap-2">
          <Button
            type="button"
            variant={sortKey === "number" ? "default" : "outline"}
            size="sm"
            className="h-7 flex-1 text-xs"
            onClick={() => onSortChange("number")}
          >
            Number
          </Button>
          <Button
            type="button"
            variant={sortKey === "lastModified" ? "default" : "outline"}
            size="sm"
            className="h-7 flex-1 text-xs"
            onClick={() => onSortChange("lastModified")}
          >
            Last Modified
          </Button>
        </div>
      </div>
      <ul className="flex-1 space-y-1 overflow-y-auto px-2 py-2">
        {items.length === 0 ? (
          <li className="px-4 py-10 text-center text-sm text-foreground-muted">
            {isSearching ? `No items match “${search.trim()}”.` : "No Business Central items synced yet."}
          </li>
        ) : (
          items.map(({ item }) => {
            const isActive = selectedId === item.id;
            const hasConflict = conflictItemIds.includes(item.id);
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onSelect(item.id)}
                  className={cn(
                    "group w-full rounded-lg px-3 py-2.5 text-left transition-colors",
                    isActive
                      ? "bg-primary-subtle text-foreground blue-glow-sm"
                      : "text-foreground hover:bg-surface",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{item.displayName}</p>
                      <p className="mt-0.5 font-mono text-xs text-foreground-muted">
                        {item.bcItemNumber ?? "No BC number"}
                      </p>
                    </div>
                    <Badge
                      variant={SYNC_STATUS_VARIANT[item.syncStatus]}
                      className="px-1.5 py-0 text-[10px]"
                    >
                      {SYNC_STATUS_LABEL[item.syncStatus]}
                    </Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {item.blocked && (
                      <Badge
                        variant="destructive"
                        className="px-1.5 py-0 text-[10px]"
                      >
                        Blocked
                      </Badge>
                    )}
                    {hasConflict && (
                      <Badge
                        variant="warning"
                        className="px-1.5 py-0 text-[10px]"
                      >
                        BC changed
                      </Badge>
                    )}
                  </div>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </aside>
  );
}

function NotConfiguredState({
  onVerify,
  isPending,
}: {
  onVerify: () => void;
  isPending: boolean;
}) {
  return (
    <EmptyState
      tone="muted"
      icon={<Link2Off className="size-7" />}
      title="Business Central is not connected"
      body="Ask an admin to set up the Business Central connection to import and sync item master data."
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button type="button" onClick={onVerify} disabled={isPending}>
            Verify connection
          </Button>
          <Button asChild variant="outline">
            <Link href="/settings">Go to Settings</Link>
          </Button>
        </div>
      }
    />
  );
}

function NothingSyncedState({
  onSync,
  isPending,
  canSync,
}: {
  onSync: () => void;
  isPending: boolean;
  canSync: boolean;
}) {
  return (
    <EmptyState
      tone="primary"
      icon={<PackageOpen className="size-7" />}
      title="No items synced yet"
      body="Click Sync Now to import items from Business Central."
      action={
        <Button
          type="button"
          disabled={!canSync || isPending}
          onClick={onSync}
          title="Import items from Business Central"
        >
          <RefreshCw className="size-4" />
          Sync Now
        </Button>
      }
    />
  );
}

function ConnectionErrorState({
  connection,
  onRetry,
  isPending,
}: {
  connection: Extract<ConnectionState, { kind: "error" }>;
  onRetry: () => void;
  isPending: boolean;
}) {
  return (
    <EmptyState
      tone="destructive"
      icon={<AlertCircle className="size-7" />}
      title="Connection error"
      body={`${connection.lastError}. Last successful sync: never.`}
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            type="button"
            disabled={isPending}
            onClick={onRetry}
            title="Retry Business Central connection verification"
          >
            <RefreshCw className="size-4" />
            Retry
          </Button>
          <Button asChild variant="outline">
            <Link href="/settings">Review settings</Link>
          </Button>
        </div>
      }
    />
  );
}

function LoadingState() {
  return (
    <EmptyState
      tone="primary"
      icon={<Loader2 className="size-7 animate-spin" />}
      title="Loading items"
      body="Preparing Business Central item data."
    />
  );
}

function EmptyState({
  icon,
  title,
  body,
  action,
  tone = "muted",
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
  tone?: "primary" | "muted" | "destructive";
}) {
  const toneClasses: Record<typeof tone, string> = {
    primary: "bg-primary-subtle text-primary",
    muted: "bg-surface text-foreground-muted",
    destructive: "bg-destructive-subtle text-destructive",
  };

  return (
    <div className="flex flex-1 items-center justify-center p-10">
      <div className="max-w-sm space-y-4 text-center">
        <div
          className={cn(
            "mx-auto flex size-16 items-center justify-center rounded-2xl",
            toneClasses[tone],
          )}
        >
          {icon}
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          <p className="text-sm text-foreground-muted">{body}</p>
        </div>
        {action && <div className="pt-1">{action}</div>}
      </div>
    </div>
  );
}

function DetailPanel({
  entry,
  events,
  references,
  itemNames,
  categories,
  packagingItemCombos,
  productLines,
  access,
  tab,
  onTabChange,
  canEdit,
  isPending,
  pendingAction,
  hasConflict,
  onEditItemField,
  onEditDetailField,
  onSaveLocal,
  onRevertUnsaved,
  onPushToBc,
  onDelete,
  onSimulateBcUpdate,
}: {
  entry: BusinessCentralItemWithDetails;
  events: BusinessCentralSyncEvent[];
  references: BusinessCentralReferenceData;
  itemNames: ItemName[];
  categories: Category[];
  packagingItemCombos: PackagingItemCombo[];
  productLines: ProductLine[];
  access: ResolvedUserAccess;
  tab: TabKey;
  onTabChange: (next: TabKey) => void;
  canEdit: boolean;
  isPending: boolean;
  pendingAction: ActionKey | null;
  hasConflict: boolean;
  onEditItemField: (
    field: EditableItemField,
    value: string | number | boolean | null,
  ) => void;
  onEditDetailField: (
    field: EditableDetailField,
    value: string | number | null,
  ) => void;
  onSaveLocal: () => void;
  onRevertUnsaved: () => void;
  onPushToBc: () => void;
  onDelete: () => void;
  onSimulateBcUpdate: () => void;
}) {
  const { item, details } = entry;
  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: "bc", label: "Business Central" },
    { key: "nexus", label: "Nexus fields" },
    { key: "retailer", label: "Retailer / pallet" },
    { key: "audit", label: "Sync & audit" },
    { key: "gs1", label: "GTIN" },
    { key: "purchases", label: "Purchases" },
  ];

  const hasInvalidValues = getValidationErrors(entry).length > 0;
  const canSave =
    canEdit && item.syncStatus === "local_dirty" && !hasInvalidValues;
  const canRevert = canEdit && item.syncStatus === "local_dirty";
  const canPush =
    canEdit &&
    ["unpushed", "never_synced", "failed"].includes(item.syncStatus) &&
    !hasInvalidValues;
  const canDelete = canEdit && item.syncStatus !== "deleted_in_bc";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-3 border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-foreground">
                {item.displayName}
              </h2>
              <Badge variant={SYNC_STATUS_VARIANT[item.syncStatus]}>
                {SYNC_STATUS_LABEL[item.syncStatus]}
              </Badge>
              {item.blocked && <Badge variant="destructive">Blocked</Badge>}
              {hasConflict && (
                <Badge variant="warning">BC updated while editing</Badge>
              )}
            </div>
            <p className="font-mono text-sm text-foreground-muted">
              {item.bcItemNumber ?? "No BC number"} · {item.bcCompanyId}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!canSave || isPending}
              onClick={onSaveLocal}
            >
              {pendingAction === "save" ? "Saving…" : "Save local"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!canRevert || isPending}
              onClick={onRevertUnsaved}
            >
              Revert
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!canPush || isPending}
              onClick={onPushToBc}
            >
              {pendingAction === "push" ? "Pushing…" : "Push to BC"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={isPending || !canEdit || item.syncStatus !== "local_dirty"}
              onClick={onSimulateBcUpdate}
            >
              <GitCompareArrows className="size-4" />
              Simulate BC update
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={!canDelete || isPending}
              onClick={onDelete}
            >
              <Trash2 className="size-4" />
              {pendingAction === "delete" ? "Deleting…" : "Delete in BC"}
            </Button>
          </div>
        </div>

        {!canEdit && (
          <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs text-foreground-muted">
            Editing Business Central item fields is currently limited to admins
            in this prototype.
          </div>
        )}

        <nav className="-mx-1 flex gap-1" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => onTabChange(t.key)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                tab === t.key
                  ? "bg-primary-subtle text-primary"
                  : "text-foreground-muted hover:bg-surface hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "bc" && (
          <BcFieldsPanel
            item={item}
            references={references}
            canEdit={canEdit}
            onEdit={onEditItemField}
          />
        )}
        {tab === "nexus" && (
          <NexusFieldsPanel
            details={details}
            canEdit={canEdit}
            onEdit={onEditDetailField}
          />
        )}
        {tab === "retailer" && (
          <RetailerFieldsPanel
            details={details}
            canEdit={canEdit}
            onEdit={onEditDetailField}
          />
        )}
        {tab === "audit" && (
          <AuditPanel
            item={item}
            events={events}
            hasConflict={hasConflict}
            validationErrors={getValidationErrors(entry)}
          />
        )}
        {tab === "gs1" && (
          <div className="space-y-3">
            <Gs1FieldsPanel bcItemId={item.id} canEdit={canEdit} />
            <BarcodeUploadsPanel bcItemId={item.id} canEdit={canEdit} />
          </div>
        )}
        {tab === "purchases" && (
          <PurchasesPanel
            businessCentralItemRowId={item.id}
            itemNames={itemNames}
            categories={categories}
            packagingItemCombos={packagingItemCombos}
            productLines={productLines}
            access={access}
          />
        )}
      </div>
    </div>
  );
}

function BcFieldsPanel({
  item,
  references,
  canEdit,
  onEdit,
}: {
  item: BusinessCentralItemWithDetails["item"];
  references: BusinessCentralReferenceData;
  canEdit: boolean;
  onEdit: (
    field: EditableItemField,
    value: string | number | boolean | null,
  ) => void;
}) {
  return (
    <FieldCard title="Business Central fields">
      <ReadonlyField
        label="Number"
        value={<span className="font-mono">{item.bcItemNumber ?? "—"}</span>}
      />
      <TextField
        label="Display name"
        value={item.displayName}
        disabled={!canEdit}
        onChange={(value) => onEdit("displayName", value)}
      />
      <TextField
        label="Display name 2"
        value={item.displayName2 ?? ""}
        disabled={!canEdit}
        onChange={(value) => onEdit("displayName2", value || null)}
      />
      <ReadonlyField label="Type" value={item.type ?? "—"} />
      <ReferenceSelectField
        label="Category"
        value={item.itemCategoryCode}
        options={references.itemCategories}
        disabled={!canEdit}
        helper="Choose from Business Central item categories."
        onChange={(value) => {
          onEdit("itemCategoryId", lookupReferenceId(references.itemCategories, value));
          onEdit("itemCategoryCode", value);
        }}
      />
      <BooleanField
        label="Blocked"
        value={item.blocked}
        disabled={!canEdit}
        onChange={(value) => onEdit("blocked", value)}
      />
      <TextField
        label="GTIN"
        value={item.gtin ?? ""}
        disabled={!canEdit}
        mono
        onChange={(value) => onEdit("gtin", value || null)}
      />
      <ReadonlyField
        label="Inventory"
        value={item.inventory ?? "—"}
      />
      <NumberField
        label="Unit price"
        value={item.unitPrice}
        disabled={!canEdit}
        onChange={(value) => onEdit("unitPrice", value)}
      />
      <BooleanField
        label="Price includes tax"
        value={item.priceIncludesTax}
        disabled={!canEdit}
        onChange={(value) => onEdit("priceIncludesTax", value)}
      />
      <NumberField
        label="Unit cost"
        value={item.unitCost}
        disabled
        helper="Locked after item creation; Business Central does not allow Unit Cost changes once ledger entries exist."
        onChange={(value) => onEdit("unitCost", value)}
      />
      <ReferenceSelectField
        label="Tax group"
        value={item.taxGroupCode}
        options={references.taxGroups}
        disabled={!canEdit}
        helper="Choose from Business Central tax groups."
        onChange={(value) => {
          onEdit("taxGroupId", lookupReferenceId(references.taxGroups, value));
          onEdit("taxGroupCode", value);
        }}
      />
      <ReferenceSelectField
        label="Base UoM"
        value={item.baseUnitOfMeasureCode}
        options={references.unitsOfMeasure}
        disabled={!canEdit}
        helper="Choose from Business Central units of measure."
        onChange={(value) => {
          onEdit("baseUnitOfMeasureId", lookupReferenceId(references.unitsOfMeasure, value));
          onEdit("baseUnitOfMeasureCode", value);
        }}
      />
      <ReferenceSelectField
        label="General product posting group"
        value={item.generalProductPostingGroupCode}
        options={references.generalProductPostingGroups}
        disabled={!canEdit}
        helper="Choose from Business Central general product posting groups."
        onChange={(value) => {
          onEdit("generalProductPostingGroupId", lookupReferenceId(references.generalProductPostingGroups, value));
          onEdit("generalProductPostingGroupCode", value);
        }}
      />
      <ReferenceSelectField
        label="Inventory posting group"
        value={item.inventoryPostingGroupCode}
        options={references.inventoryPostingGroups}
        disabled={!canEdit}
        helper="Choose from Business Central inventory posting groups."
        onChange={(value) => {
          onEdit("inventoryPostingGroupId", lookupReferenceId(references.inventoryPostingGroups, value));
          onEdit("inventoryPostingGroupCode", value);
        }}
      />
    </FieldCard>
  );
}

function NexusFieldsPanel({
  details,
  canEdit,
  onEdit,
}: {
  details: BusinessCentralItemWithDetails["details"];
  canEdit: boolean;
  onEdit: (field: EditableDetailField, value: string | number | null) => void;
}) {
  return (
    <FieldCard title="Nexus-only fields">
      <TextField
        label="Artwork status"
        value={details.artworkStatus ?? ""}
        disabled={!canEdit}
        onChange={(value) => onEdit("artworkStatus", value || null)}
      />
      <NumberField
        label="Net weight (g)"
        value={details.netWeightGrams}
        disabled={!canEdit}
        onChange={(value) => onEdit("netWeightGrams", value)}
      />
      <ReadonlyField
        label="Net weight (oz)"
        value={<CalculatedValue value={details.netWeightOz} suffix="oz" />}
      />
    </FieldCard>
  );
}

function RetailerFieldsPanel({
  details,
  canEdit,
  onEdit,
}: {
  details: BusinessCentralItemWithDetails["details"];
  canEdit: boolean;
  onEdit: (field: EditableDetailField, value: string | number | null) => void;
}) {
  return (
    <div className="space-y-4">
      <FieldCard title="Shared">
        <TextField
          label="Sam's Club item #"
          value={details.samsClubItemNumber ?? ""}
          disabled={!canEdit}
          mono
          onChange={(value) => onEdit("samsClubItemNumber", value || null)}
        />
        <NumberField
          label="Units per case"
          value={details.unitsPerCase}
          integer
          disabled={!canEdit}
          onChange={(value) => onEdit("unitsPerCase", value)}
        />
      </FieldCard>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <FieldCard title="Costco pallet">
          <NumberField
            label="Cases / layer"
            value={details.costcoCasesPerLayer}
            integer
            disabled={!canEdit}
            onChange={(value) => onEdit("costcoCasesPerLayer", value)}
          />
          <NumberField
            label="Layers / pallet"
            value={details.costcoLayersPerPallet}
            integer
            disabled={!canEdit}
            onChange={(value) => onEdit("costcoLayersPerPallet", value)}
          />
          <ReadonlyField
            label="Units / pallet"
            value={<CalculatedValue value={details.costcoUnitsPerPallet} />}
          />
        </FieldCard>
        <FieldCard title="Sam's Club pallet">
          <NumberField
            label="Cases / layer"
            value={details.samsCasesPerLayer}
            integer
            disabled={!canEdit}
            onChange={(value) => onEdit("samsCasesPerLayer", value)}
          />
          <NumberField
            label="Layers / pallet"
            value={details.samsLayersPerPallet}
            integer
            disabled={!canEdit}
            onChange={(value) => onEdit("samsLayersPerPallet", value)}
          />
          <ReadonlyField
            label="Units / pallet"
            value={<CalculatedValue value={details.samsUnitsPerPallet} />}
          />
        </FieldCard>
      </div>
    </div>
  );
}

function AuditPanel({
  item,
  events,
  hasConflict,
  validationErrors,
}: {
  item: BusinessCentralItemWithDetails["item"];
  events: BusinessCentralSyncEvent[];
  hasConflict: boolean;
  validationErrors: string[];
}) {
  return (
    <div className="space-y-4">
      {hasConflict && (
        <div className="rounded-xl border border-border bg-warning-subtle p-4 text-sm text-warning">
          Business Central was updated while this item had local edits. Phase 5
          will compare the real BC payload before pushing; this prototype keeps
          the conflict visible in the timeline.
        </div>
      )}
      {validationErrors.length > 0 && (
        <div className="rounded-xl border border-border bg-destructive-subtle p-4 text-sm text-destructive">
          <p className="font-medium">
            Fix validation before saving or pushing:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {validationErrors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}
      <FieldCard title="Sync metadata">
        <ReadonlyField
          label="BC item ID"
          value={<span className="font-mono text-xs">{item.bcItemId}</span>}
        />
        <ReadonlyField
          label="BC company ID"
          value={<span className="font-mono text-xs">{item.bcCompanyId}</span>}
        />
        <ReadonlyField
          label="Sync status"
          value={
            <Badge variant={SYNC_STATUS_VARIANT[item.syncStatus]}>
              {SYNC_STATUS_LABEL[item.syncStatus]}
            </Badge>
          }
        />
        <ReadonlyField
          label="Last synced"
          value={formatTimestamp(item.lastSyncedAt)}
        />
        <ReadonlyField
          label="Last pulled"
          value={formatTimestamp(item.lastPulledAt)}
        />
        <ReadonlyField
          label="Last pushed"
          value={formatTimestamp(item.lastPushedAt)}
        />
        <ReadonlyField
          label="Local last edited"
          value={formatTimestamp(item.localLastEditedAt)}
        />
        <ReadonlyField
          label="BC last modified"
          value={formatTimestamp(item.bcLastModifiedAt)}
        />
        <ReadonlyField
          label="BC eTag"
          value={
            <span className="font-mono text-xs">{item.bcEtag ?? "—"}</span>
          }
        />
        <ReadonlyField
          label="Last error"
          value={
            item.syncError ? (
              <span className="text-destructive">{item.syncError}</span>
            ) : (
              "—"
            )
          }
        />
      </FieldCard>
      <FieldCard title="Raw Business Central item payload">
        {Object.keys(item.rawPayload).length === 0 ? (
          <ReadonlyField label="Payload" value="—" />
        ) : (
          Object.entries(item.rawPayload)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => (
              <ReadonlyField
                key={key}
                label={key}
                value={
                  <span className="font-mono text-xs">
                    {formatRawBcValue(value)}
                  </span>
                }
              />
            ))
        )}
      </FieldCard>
      <div className="rounded-xl border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold text-foreground">
            Recent sync events
          </h3>
        </div>
        {events.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-foreground-muted">
            No events for this item yet.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {events.map((event) => (
              <li key={event.id} className="flex items-start gap-3 px-4 py-3">
                <Badge
                  variant={EVENT_STATUS_VARIANT[event.status] ?? "outline"}
                  className="mt-0.5 shrink-0 px-1.5 py-0 text-[10px] uppercase tracking-wide"
                >
                  {event.direction}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-foreground">
                    {event.errorMessage ?? event.status.replace("_", " ")}
                  </p>
                  <p className="mt-0.5 text-xs text-foreground-muted">
                    {formatTimestamp(event.createdAt)}
                    {event.actorUserLabel ? ` · ${event.actorUserLabel}` : ""}
                    {event.changedFields?.length
                      ? ` · ${event.changedFields.join(", ")}`
                      : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function lookupReferenceId(
  options: BusinessCentralReferenceItem[],
  code: string | null,
): string | null {
  if (!code) return null;
  return options.find((option) => option.code === code)?.bcId ?? null;
}

function formatRawBcValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function ReferenceSelectField({
  label,
  value,
  options,
  onChange,
  disabled,
  helper,
}: {
  label: string;
  value: string | null;
  options: BusinessCentralReferenceItem[];
  onChange: (value: string | null) => void;
  disabled?: boolean;
  helper?: string;
}) {
  const reactId = useId();
  const id = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${reactId}`;
  const normalizedValue = value ?? "";
  const hasCurrentValue = normalizedValue !== "";
  const activeOptions = options.filter((option) => option.isActive);
  const currentOption = options.find((option) => option.code === normalizedValue) ?? null;
  const currentIsActive = Boolean(currentOption?.isActive);
  const currentInActiveOptions = activeOptions.some((option) => option.code === normalizedValue);

  return (
    <div className="min-w-0 space-y-1.5">
      <Label
        htmlFor={id}
        className="text-[11px] uppercase tracking-wide text-foreground-subtle"
      >
        {label}
      </Label>
      <select
        id={id}
        value={normalizedValue}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
        className={cn(
          "border-input text-foreground shadow-xs focus-visible:border-ring focus-visible:ring-ring/50 flex h-9 w-full min-w-0 rounded-md border px-3 py-2 text-sm outline-none transition-[color,box-shadow] focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
          FIELD_CONTROL_CLASS,
        )}
      >
        <option value="">None</option>
        {hasCurrentValue && !currentInActiveOptions && (
          <option value={normalizedValue} disabled>
            {currentOption
              ? `${currentOption.code} — ${currentOption.displayName} (removed from BC)`
              : `${normalizedValue} (not in reference list)`}
          </option>
        )}
        {activeOptions.map((option) => (
          <option key={option.bcId} value={option.code}>
            {option.code} — {option.displayName}
          </option>
        ))}
      </select>
      {helper && <p className="text-xs text-foreground-muted">{helper}</p>}
      {hasCurrentValue && !currentIsActive && (
        <p className="text-xs text-warning">
          This saved value is no longer active in Business Central. Choose an active option before pushing changes.
        </p>
      )}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  disabled,
  helper,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  helper?: string;
  mono?: boolean;
}) {
  const reactId = useId();
  const id = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${reactId}`;
  return (
    <div className="min-w-0 space-y-1.5">
      <Label
        htmlFor={id}
        className="text-[11px] uppercase tracking-wide text-foreground-subtle"
      >
        {label}
      </Label>
      <Input
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={cn(FIELD_CONTROL_CLASS, mono && "font-mono")}
      />
      {helper && <p className="text-xs text-foreground-muted">{helper}</p>}
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  disabled,
  integer = false,
  helper,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  disabled?: boolean;
  integer?: boolean;
  helper?: string;
}) {
  const reactId = useId();
  const id = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${reactId}`;
  const invalid = isInvalidNumber(value, integer);
  return (
    <div className="min-w-0 space-y-1.5">
      <Label
        htmlFor={id}
        className="text-[11px] uppercase tracking-wide text-foreground-subtle"
      >
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={0}
        step={integer ? 1 : "any"}
        value={value ?? ""}
        disabled={disabled}
        aria-invalid={invalid}
        onChange={(event) => onChange(coerceNullableNumber(event.target.value))}
        className={FIELD_CONTROL_CLASS}
      />
      {helper && <p className="text-xs text-foreground-muted">{helper}</p>}
      {invalid && (
        <p className="text-xs text-destructive">
          Enter a non-negative {integer ? "whole number" : "number"}.
        </p>
      )}
    </div>
  );
}

function BooleanField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={cn("flex min-w-0 items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm text-foreground", FIELD_CONTROL_CLASS)}>
      <input
        type="checkbox"
        checked={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 rounded border-border"
      />
      <span>{label}</span>
    </label>
  );
}

function ReadonlyField({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-foreground-subtle">
        {label}
      </dt>
      <dd className="mt-1 break-words text-sm text-foreground">{value}</dd>
    </div>
  );
}

function CalculatedValue({
  value,
  suffix,
}: {
  value: number | null;
  suffix?: string;
}) {
  if (value === null)
    return <span className="text-foreground-subtle italic">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-primary-subtle px-2 py-1 text-primary">
      <span>
        {value}
        {suffix ? ` ${suffix}` : ""}
      </span>
      <span className="text-[10px] font-medium uppercase tracking-wide text-foreground-subtle">
        calc
      </span>
    </span>
  );
}

function FieldCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 p-4 sm:grid-cols-2">
        {children}
      </div>
    </div>
  );
}

function CreateItemDialog({
  open,
  onOpenChange,
  references,
  categories = [],
  isPending,
  pendingAction,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  references: BusinessCentralReferenceData;
  categories?: Category[];
  isPending: boolean;
  pendingAction: ActionKey | null;
  onCreate: (draft: CreateBusinessCentralItemDraft) => void;
}) {
  const numberInputId = useId();
  const [templates, setTemplates] = useState<ItemTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");

  // Load templates once when the dialog opens
  useEffect(() => {
    if (!open) return;
    listItemTemplates()
      .then(setTemplates)
      .catch(() => { /* silently ignore — templates are optional */ });
  }, [open]);

  const getSeriesCode = (categoryId: string | null): string | null => {
    if (!categoryId) return null;
    return categories.find((c) => c.id === categoryId)?.bc_no_series_code ?? null;
  };

  const defaultDraft = (): CreateBusinessCentralItemDraft => ({
    bcItemNumber: "ZZ-TEST-",
    displayName: "",
    type: "Inventory",
    itemCategoryCode: "",
    taxGroupCode: "",
    baseUnitOfMeasureCode: "EA",
    unitPrice: null,
    unitCost: null,
    gtin: null,
    categoryId: null,
    manualNumber: true,
    generalProductPostingGroupCode: null,
    inventoryPostingGroupCode: null,
  });

  const [draft, setDraft] = useState<CreateBusinessCentralItemDraft>(defaultDraft);

  const seriesCode = getSeriesCode(draft.categoryId);

  const handleTemplateChange = (templateId: string) => {
    setSelectedTemplateId(templateId);
    if (!templateId) return;
    const template = templates.find((t) => t.id === templateId);
    if (!template) return;
    const fromTemplate = templateToCreateInput(template, { displayName: draft.displayName });
    const newCategoryId = template.category_id ?? null;
    const hasSeriesCode = Boolean(getSeriesCode(newCategoryId));
    setDraft((prev) => ({
      ...prev,
      ...fromTemplate,
      itemCategoryCode: fromTemplate.itemCategoryCode ?? prev.itemCategoryCode,
      taxGroupCode: fromTemplate.taxGroupCode ?? prev.taxGroupCode,
      baseUnitOfMeasureCode: fromTemplate.baseUnitOfMeasureCode ?? prev.baseUnitOfMeasureCode,
      type: fromTemplate.type ?? prev.type,
      categoryId: newCategoryId,
      manualNumber: !hasSeriesCode,
    }));
  };

  const handleCategoryIdChange = (categoryId: string | null) => {
    const hasSeriesCode = Boolean(getSeriesCode(categoryId));
    setDraft((prev) => ({
      ...prev,
      categoryId,
      manualNumber: !hasSeriesCode,
    }));
  };

  const errors = [
    draft.manualNumber && !draft.bcItemNumber.trim() ? "BC item number is required." : null,
    draft.displayName.trim() ? null : "Display name is required.",
    draft.type.trim() ? null : "Type is required.",
    draft.baseUnitOfMeasureCode.trim() ? null : "Base UoM is required.",
    isInvalidNumber(draft.unitPrice)
      ? "Unit price must be non-negative."
      : null,
    isInvalidNumber(draft.unitCost) ? "Unit cost must be non-negative." : null,
  ].filter(Boolean) as string[];

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (errors.length > 0) return;
    onCreate({
      ...draft,
      bcItemNumber: draft.bcItemNumber.trim(),
      displayName: draft.displayName.trim(),
      type: draft.type.trim(),
      itemCategoryCode: draft.itemCategoryCode.trim(),
      taxGroupCode: draft.taxGroupCode.trim(),
      baseUnitOfMeasureCode: draft.baseUnitOfMeasureCode.trim(),
      gtin: draft.gtin?.trim() || null,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Create item</DialogTitle>
            <DialogDescription>
              Prototype-only local draft. Use the ZZ-TEST- prefix for sandbox
              test items.
            </DialogDescription>
          </DialogHeader>

          {/* Template picker */}
          {templates.length > 0 && (
            <div className="min-w-0 space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wide text-foreground-subtle">
                Template
              </Label>
              <select
                value={selectedTemplateId}
                onChange={(e) => handleTemplateChange(e.target.value)}
                className="border-input text-foreground shadow-xs focus-visible:border-ring focus-visible:ring-ring/50 flex h-9 w-full min-w-0 rounded-md border px-3 py-2 text-sm outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
              >
                <option value="">— No template —</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {/* Packaging category (drives auto-number series) */}
            <div className="min-w-0 space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wide text-foreground-subtle">
                Packaging category
              </Label>
              <select
                value={draft.categoryId ?? ""}
                onChange={(e) => handleCategoryIdChange(e.target.value || null)}
                className="border-input text-foreground shadow-xs focus-visible:border-ring focus-visible:ring-ring/50 flex h-9 w-full min-w-0 rounded-md border px-3 py-2 text-sm outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
              >
                <option value="">— None —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.bc_no_series_code ? ` (${c.bc_no_series_code})` : ""}
                  </option>
                ))}
              </select>
            </div>

            {/* BC item number — auto or manual */}
            <div className="min-w-0 space-y-1.5">
              <Label
                htmlFor={numberInputId}
                className="text-[11px] uppercase tracking-wide text-foreground-subtle"
              >
                BC item number
              </Label>
              {draft.manualNumber ? (
                <Input
                  id={numberInputId}
                  value={draft.bcItemNumber}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, bcItemNumber: e.target.value }))
                  }
                  className="font-mono"
                />
              ) : (
                <div className="flex h-9 items-center rounded-md border border-input bg-muted px-3 text-sm text-foreground-muted font-mono">
                  Auto-assigned on save
                </div>
              )}
              {seriesCode && !draft.manualNumber && (
                <p className="text-xs text-foreground-muted">
                  Will be assigned from {seriesCode} on save
                </p>
              )}
              <div className="flex items-center gap-2 pt-0.5">
                <input
                  type="checkbox"
                  id="manual-number-toggle"
                  checked={draft.manualNumber}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, manualNumber: e.target.checked }))
                  }
                  className="h-4 w-4 rounded border-input"
                />
                <Label
                  htmlFor="manual-number-toggle"
                  className="text-xs text-foreground-muted cursor-pointer"
                >
                  Set manually
                </Label>
              </div>
            </div>

            <TextField
              label="Display name"
              value={draft.displayName}
              onChange={(value) =>
                setDraft((prev) => ({ ...prev, displayName: value }))
              }
            />
            <TextField
              label="Type"
              value={draft.type}
              onChange={(value) =>
                setDraft((prev) => ({ ...prev, type: value }))
              }
            />
            <ReferenceSelectField
              label="Category"
              value={draft.itemCategoryCode}
              options={references.itemCategories}
              onChange={(value) =>
                setDraft((prev) => ({ ...prev, itemCategoryCode: value ?? "" }))
              }
            />
            <ReferenceSelectField
              label="Tax group"
              value={draft.taxGroupCode}
              options={references.taxGroups}
              onChange={(value) =>
                setDraft((prev) => ({ ...prev, taxGroupCode: value ?? "" }))
              }
            />
            <ReferenceSelectField
              label="Base UoM"
              value={draft.baseUnitOfMeasureCode}
              options={references.unitsOfMeasure}
              onChange={(value) =>
                setDraft((prev) => ({ ...prev, baseUnitOfMeasureCode: value ?? "" }))
              }
            />
            <TextField
              label="GTIN"
              value={draft.gtin ?? ""}
              mono
              onChange={(value) =>
                setDraft((prev) => ({ ...prev, gtin: value || null }))
              }
            />
            <NumberField
              label="Unit price"
              value={draft.unitPrice}
              onChange={(value) =>
                setDraft((prev) => ({ ...prev, unitPrice: value }))
              }
            />
            <NumberField
              label="Unit cost"
              value={draft.unitCost}
              onChange={(value) =>
                setDraft((prev) => ({ ...prev, unitCost: value }))
              }
            />
          </div>
          {errors.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-destructive">
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={errors.length > 0 || isPending}>
              {pendingAction === "create" ? "Creating…" : "Create in Business Central"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteItemDialog({
  open,
  onOpenChange,
  item,
  isPending,
  pendingAction,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: BusinessCentralItemWithDetails;
  isPending: boolean;
  pendingAction: ActionKey | null;
  onDelete: (confirmation: string) => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const expected = item.item.bcItemNumber ?? item.item.displayName;
  const canDelete = confirmation === expected;

  const handleDelete = () => {
    if (!canDelete) return;
    onDelete(confirmation);
    setConfirmation("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete item in Business Central</DialogTitle>
          <DialogDescription>
            This deletes the item in Business Central and removes it from Nexus. Type the BC item number
            to confirm.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-foreground-muted">
            Confirm deletion for{" "}
            <span className="font-mono text-foreground">{expected}</span>.
          </p>
          <TextField
            label="Confirmation"
            value={confirmation}
            mono
            onChange={setConfirmation}
          />
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!canDelete || isPending}
            onClick={handleDelete}
          >
            {pendingAction === "delete" ? "Deleting…" : "Delete item"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function getValidationErrors(entry: BusinessCentralItemWithDetails): string[] {
  const errors: string[] = [];
  const { item, details } = entry;

  if (item.displayName.trim() === "") errors.push("Display name is required.");
  if (isInvalidNumber(item.unitPrice))
    errors.push("Unit price must be non-negative.");
  if (isInvalidNumber(item.unitCost))
    errors.push("Unit cost must be non-negative.");
  if (isInvalidNumber(details.netWeightGrams))
    errors.push("Net weight must be non-negative.");

  for (const field of INTEGER_DETAIL_FIELDS) {
    if (isInvalidNumber(details[field] as number | null, true)) {
      errors.push(`${field} must be a non-negative whole number.`);
    }
  }

  return errors;
}
