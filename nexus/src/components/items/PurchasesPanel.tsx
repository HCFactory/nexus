'use client';

import { useCallback, useEffect, useState } from 'react';
import { createCategory, updateCategory } from '@/app/actions/categories';
import { createItemName, updateItemName } from '@/app/actions/itemNames';
import { updateItem } from '@/app/actions/items';
import { createProductLine } from '@/app/actions/productLines';
import {
  createPurchaseVersionTargetForBusinessCentralItem,
  createUnversionedPurchaseComboForBusinessCentralItem,
  getLinkedPurchaseTargetsForBusinessCentralItem,
  getPurchaseReferenceData,
  linkBusinessCentralItemToPackagingCombo,
} from '@/app/actions/itemPurchases';
import { PackagingItemCombobox } from '@/components/orders/PackagingItemCombobox';
import { PackagingForm } from '@/components/packaging/PackagingForm';
import { CategoryForm } from '@/components/packaging/CategoryForm';
import { CategorySelector } from '@/components/packaging/CategorySelector';
import { ItemNameCombobox } from '@/components/packaging/ItemNameCombobox';
import { UserAccess } from '@/lib/auth/permissions';
import {
  Category,
  ItemName,
  LinkedPurchaseTargets,
  ItemWithCategory,
  PackagingItemCombo,
  ProductLine,
  PurchaseVersionTarget,
} from '@/types/database';
import { PurchaseVersionBlock } from './PurchaseVersionBlock';
import { usePropState } from '@/hooks/usePropState';

interface PurchasesPanelProps {
  businessCentralItemRowId: string;
  itemNames: ItemName[];
  categories: Category[];
  packagingItemCombos: PackagingItemCombo[];
  productLines: ProductLine[];
  access: UserAccess;
}

function sortItemNames(items: ItemName[]) {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

function sortCategories(items: Category[]) {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

function sortProductLines(items: ProductLine[]) {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

function sortCombos(items: PackagingItemCombo[]) {
  return [...items].sort((a, b) =>
    `${a.item_name?.name ?? ''} ${a.category?.name ?? ''}`.localeCompare(
      `${b.item_name?.name ?? ''} ${b.category?.name ?? ''}`,
      undefined,
      { numeric: true, sensitivity: 'base' }
    )
  );
}

function purchaseTargetToItem(target: PurchaseVersionTarget): ItemWithCategory {
  return {
    id: target.itemId,
    item_name_id: target.itemNameId,
    category_id: target.categoryId,
    product_line_id: target.productLineId,
    version: target.version,
    status: target.status,
    archived: false,
    organization_id: null,
    bc_connection_id: null,
    bc_item_id: null,
    created_by: null,
    created_at: target.updatedAt,
    updated_at: target.updatedAt,
    item_name: target.itemName,
    category: target.category,
    product_line: target.productLine,
  };
}

function upsertCombo(combos: PackagingItemCombo[], combo: PackagingItemCombo) {
  return sortCombos([
    ...combos.filter((existing) => existing.item_name_id !== combo.item_name_id || existing.category_id !== combo.category_id),
    combo,
  ]);
}

export function PurchasesPanel({
  businessCentralItemRowId,
  itemNames,
  categories,
  packagingItemCombos,
  productLines,
  access,
}: PurchasesPanelProps) {
  const [localItemNames, setLocalItemNames] = usePropState<ItemName[]>(itemNames);
  const [localCategories, setLocalCategories] = usePropState<Category[]>(categories);
  const [localCombos, setLocalCombos] = usePropState<PackagingItemCombo[]>(packagingItemCombos);
  const [localProductLines, setLocalProductLines] = usePropState<ProductLine[]>(productLines);
  const [linkedTargets, setLinkedTargets] = useState<LinkedPurchaseTargets | null>(null);
  const [draftItemNameId, setDraftItemNameId] = useState<string | null>(null);
  const [draftCategoryId, setDraftCategoryId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [newVersion, setNewVersion] = useState('');
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [editingTarget, setEditingTarget] = useState<PurchaseVersionTarget | null>(null);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [categoryCreatedCallback, setCategoryCreatedCallback] = useState<((category: Category) => void) | null>(null);

  const canManagePurchases = access.canManageCatalog;

  const applyTargets = useCallback((targets: LinkedPurchaseTargets) => {
    setLinkedTargets(targets);
    setDraftItemNameId(targets.itemNameId);
    setDraftCategoryId(targets.categoryId);
    if (targets.linkedCombo) {
      setLocalCombos((prev) => upsertCombo(prev, targets.linkedCombo!));
    }
  }, [setLocalCombos]);

  const refreshTargets = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const targets = await getLinkedPurchaseTargetsForBusinessCentralItem(businessCentralItemRowId);
      applyTargets(targets);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load purchase links');
    } finally {
      setLoading(false);
    }
  }, [applyTargets, businessCentralItemRowId]);

  const refreshReferenceData = useCallback(async () => {
    const refs = await getPurchaseReferenceData();
    setLocalItemNames(refs.itemNames);
    setLocalCategories(refs.categories);
    setLocalCombos(refs.packagingItemCombos);
  }, [setLocalItemNames, setLocalCategories, setLocalCombos]);

  // Switching to another item shows the loading state again while it loads.
  const [loadedItemId, setLoadedItemId] = useState(businessCentralItemRowId);
  if (loadedItemId !== businessCentralItemRowId) {
    setLoadedItemId(businessCentralItemRowId);
    setLoading(true);
    setError('');
  }

  // Initial load. State is only set once the request settles, and a result for
  // an item we've since left is ignored.
  useEffect(() => {
    let cancelled = false;
    getLinkedPurchaseTargetsForBusinessCentralItem(businessCentralItemRowId)
      .then(
        (targets) => {
          if (!cancelled) applyTargets(targets);
        },
        (err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load purchase links');
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyTargets, businessCentralItemRowId]);

  const linkOrCreateCombo = async (itemNameId: string, categoryId: string) => {
    if (!canManagePurchases || pending) return null;
    setPending(true);
    setError('');
    try {
      const existingCombo = localCombos.find(
        (combo) => combo.item_name_id === itemNameId && combo.category_id === categoryId
      );
      const targets = existingCombo
        ? await linkBusinessCentralItemToPackagingCombo({ businessCentralItemRowId, itemNameId, categoryId })
        : await createUnversionedPurchaseComboForBusinessCentralItem({ businessCentralItemRowId, itemNameId, categoryId });
      applyTargets(targets);
      await refreshReferenceData();
      return targets.linkedCombo;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update purchase item link');
      await refreshTargets();
      return null;
    } finally {
      setPending(false);
    }
  };

  const handleItemNameSelect = (itemNameId: string | null) => {
    setDraftItemNameId(itemNameId);
    if (itemNameId && draftCategoryId) {
      void linkOrCreateCombo(itemNameId, draftCategoryId);
    }
  };

  const handleCategorySelect = (categoryId: string) => {
    setDraftCategoryId(categoryId);
    if (draftItemNameId) {
      void linkOrCreateCombo(draftItemNameId, categoryId);
    }
  };

  const handleCreateProductLine = async (name: string) => {
    if (!canManagePurchases) throw new Error('You do not have permission to manage purchase item links');
    const productLine = await createProductLine(name);
    setLocalProductLines((prev) => sortProductLines([...prev.filter((existing) => existing.id !== productLine.id), productLine]));
    return productLine;
  };

  const handleCreateItemName = async (name: string) => {
    if (!canManagePurchases) throw new Error('You do not have permission to manage purchase item links');
    const itemName = await createItemName(name);
    setLocalItemNames((prev) => sortItemNames([...prev.filter((existing) => existing.id !== itemName.id), itemName]));
    return itemName;
  };

  const handleUpdateItemName = async (id: string, name: string) => {
    if (!canManagePurchases) throw new Error('You do not have permission to manage purchase item links');
    const itemName = await updateItemName(id, name);
    setLocalItemNames((prev) => sortItemNames(prev.map((existing) => existing.id === itemName.id ? itemName : existing)));
    return itemName;
  };

  const handleCreateCategoryRequest = (prefillName?: string, onCreated?: (category: Category) => void) => {
    if (!canManagePurchases) return;
    setNewCategoryName(prefillName?.trim() ?? '');
    setCategoryCreatedCallback(() => onCreated ?? null);
    setCreatingCategory(true);
  };

  const handleCreateCombination = async (itemNameId: string, categoryId: string) => {
    const combo = await linkOrCreateCombo(itemNameId, categoryId);
    if (!combo) throw new Error('Failed to create purchase item combination');
    return combo;
  };

  const handleUpdateVersionTarget = async (data: {
    item_name_id: string;
    category_id: string;
    product_line_id: string | null;
    version: string | null;
  }) => {
    if (!editingTarget) return;
    if (!canManagePurchases) throw new Error('You do not have permission to manage purchase item links');
    await updateItem(editingTarget.itemId, data);
    setEditingTarget(null);
    await refreshTargets();
    await refreshReferenceData();
  };

  const handleCreateVersion = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!linkedTargets?.itemNameId || !linkedTargets.categoryId || pending) return;
    setPending(true);
    setError('');
    try {
      await createPurchaseVersionTargetForBusinessCentralItem({
        businessCentralItemRowId,
        itemNameId: linkedTargets.itemNameId,
        categoryId: linkedTargets.categoryId,
        version: newVersion,
      });
      setNewVersion('');
      await refreshTargets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create version target');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-foreground">Purchase item link</h3>
          <p className="mt-1 text-xs text-foreground-muted">
            Link this Business Central item to one packaging item name/category combo across all active versions.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-foreground-muted">PO Item</label>
            <PackagingItemCombobox
              combos={localCombos}
              itemNames={localItemNames}
              categories={localCategories}
              selectedItemNameId={draftItemNameId}
              selectedCategoryId={draftCategoryId}
              onSelect={(combo) => {
                if (!combo) return;
                setDraftItemNameId(combo.item_name_id);
                setDraftCategoryId(combo.category_id);
                void linkOrCreateCombo(combo.item_name_id, combo.category_id);
              }}
              onCreateItemName={handleCreateItemName}
              onUpdateItemName={handleUpdateItemName}
              onCreateCategory={handleCreateCategoryRequest}
              onEditCategory={canManagePurchases ? setEditingCategory : undefined}
              onCreateCombination={handleCreateCombination}
              disabled={!canManagePurchases || pending}
            />
          </div>

          <div className={!canManagePurchases || pending ? 'pointer-events-none opacity-60' : ''}>
            <label className="mb-1 block text-xs font-medium text-foreground-muted">Name</label>
            <ItemNameCombobox
              itemNames={localItemNames}
              selectedId={draftItemNameId}
              onSelect={handleItemNameSelect}
              onCreate={handleCreateItemName}
              onUpdate={handleUpdateItemName}
              required={false}
              variant="compact"
            />
          </div>

          <div className={!canManagePurchases || pending ? 'pointer-events-none opacity-60' : ''}>
            <label className="mb-1 block text-xs font-medium text-foreground-muted">Category</label>
            <CategorySelector
              categories={localCategories}
              selectedId={draftCategoryId}
              onSelect={handleCategorySelect}
              onCreateNew={(prefillName) => handleCreateCategoryRequest(prefillName, (category) => handleCategorySelect(category.id))}
              onEdit={canManagePurchases ? setEditingCategory : undefined}
              variant="compact"
            />
          </div>
        </div>

        {!canManagePurchases && (
          <p className="mt-3 text-xs text-foreground-muted">You can view the purchase link, but cannot edit item/category links.</p>
        )}
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Artwork Versions</h3>
            <p className="mt-1 text-xs text-foreground-muted">Expand a version to view upload history or drop files onto the version block.</p>
          </div>
          {linkedTargets?.itemNameId && linkedTargets.categoryId && canManagePurchases && (
            <form onSubmit={handleCreateVersion} className="flex items-center gap-2">
              <input
                value={newVersion}
                onChange={(event) => setNewVersion(event.target.value)}
                placeholder="New version"
                className="h-8 w-36 rounded border border-border bg-surface px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <button
                type="submit"
                disabled={pending || !newVersion.trim()}
                className="h-8 rounded bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                Add version
              </button>
            </form>
          )}
        </div>

        {loading ? (
          <div className="py-8 text-center text-sm text-foreground-muted">Loading purchase targets...</div>
        ) : !linkedTargets || linkedTargets.targets.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-foreground-muted">
            Select or create a PO item combo to start tracking versions and upload history.
          </div>
        ) : (
          <div className="space-y-3">
            {linkedTargets.targets.map((target) => (
              <PurchaseVersionBlock
                key={target.itemId}
                target={target}
                access={access}
                onEdit={access.canEditPackagingItems ? setEditingTarget : undefined}
              />
            ))}
          </div>
        )}
      </section>

      {editingTarget && access.canEditPackagingItems && (
        <PackagingForm
          item={purchaseTargetToItem(editingTarget)}
          categories={localCategories}
          productLines={localProductLines}
          itemNames={localItemNames}
          onSubmit={handleUpdateVersionTarget}
          onCancel={() => setEditingTarget(null)}
          onCategoryCreated={(category) => {
            setLocalCategories((prev) => sortCategories([...prev.filter((existing) => existing.id !== category.id), category]));
          }}
          onCategoryUpdated={(category) => {
            setLocalCategories((prev) => sortCategories(prev.map((existing) => existing.id === category.id ? category : existing)));
          }}
          onCreateProductLine={handleCreateProductLine}
          onCreateItemName={handleCreateItemName}
          onUpdateItemName={handleUpdateItemName}
        />
      )}

      {creatingCategory && canManagePurchases && (
        <CategoryForm
          initialName={newCategoryName}
          zIndex={10020}
          onSubmit={async (data) => {
            if (!canManagePurchases) throw new Error('You do not have permission to manage purchase item links');
            const category = await createCategory(data);
            setLocalCategories((prev) => sortCategories([...prev.filter((existing) => existing.id !== category.id), category]));
            setCreatingCategory(false);
            setNewCategoryName('');
            categoryCreatedCallback?.(category);
            setCategoryCreatedCallback(null);
          }}
          onCancel={() => {
            setCreatingCategory(false);
            setNewCategoryName('');
            setCategoryCreatedCallback(null);
          }}
        />
      )}

      {editingCategory && canManagePurchases && (
        <CategoryForm
          category={editingCategory}
          zIndex={10020}
          onSubmit={async (data) => {
            if (!canManagePurchases) throw new Error('You do not have permission to manage purchase item links');
            const category = await updateCategory(editingCategory.id, data);
            setLocalCategories((prev) => sortCategories(prev.map((existing) => existing.id === category.id ? category : existing)));
            setEditingCategory(null);
          }}
          onCancel={() => setEditingCategory(null)}
        />
      )}
    </div>
  );
}
