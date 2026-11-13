'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useSearchParams } from 'next/navigation';
import { Plus, Search, Trash2, Boxes } from 'lucide-react';

import {
  createItemCategory,
  deleteItemCategory,
  getCategoryItemCount,
} from '@/app/actions/itemCategories';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CategoryBadge } from '@/components/ui';
import { cn } from '@/lib/utils';
import { Category, ItemTemplate } from '@/types/database';
import { ItemCategoryRow } from '@/types/itemCategories';
import type { BusinessCentralReferenceData } from '@/types/businessCentralItems';
import { CategorySettingsBlock } from './CategorySettingsBlock';
import { CategoryNumberingBlock } from './CategoryNumberingBlock';
import { CategoryTemplateBlock } from './CategoryTemplateBlock';
import { usePropState } from '@/hooks/usePropState';

interface ItemCategoriesClientProps {
  rows: ItemCategoryRow[];
  canManage: boolean;
  references: BusinessCentralReferenceData | null;
}

function numberingLabel(category: Category): string {
  return category.bc_no_series_code ? `(${category.bc_no_series_code})` : '(manual)';
}

export function ItemCategoriesClient({ rows: initialRows, canManage, references }: ItemCategoriesClientProps) {
  const searchParams = useSearchParams();
  const [rows, setRows] = usePropState<ItemCategoryRow[]>(initialRows);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const fromUrl = searchParams.get('id');
    if (fromUrl && initialRows.some((row) => row.category.id === fromUrl)) return fromUrl;
    return initialRows[0]?.category.id ?? null;
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter(({ category }) => category.name.toLowerCase().includes(query));
  }, [rows, search]);

  const selectedRow = useMemo(
    () => rows.find(({ category }) => category.id === selectedId) ?? null,
    [rows, selectedId],
  );

  function selectCategory(id: string) {
    setSelectedId(id);
    setActionError(null);
    window.history.replaceState(null, '', `/item-categories?id=${id}`);
  }

  function updateRowCategory(updated: Category) {
    setRows((current) =>
      current.map((row) => (row.category.id === updated.id ? { ...row, category: updated } : row)),
    );
  }

  function updateRowTemplate(categoryId: string, updated: ItemTemplate) {
    setRows((current) =>
      current.map((row) => (row.category.id === categoryId ? { ...row, template: updated } : row)),
    );
  }

  function handleCreated(category: Category) {
    setRows((current) => [...current, { category, template: null }].sort((a, b) => a.category.name.localeCompare(b.category.name)));
    selectCategory(category.id);
  }

  function handleDeleted(categoryId: string) {
    setRows((current) => {
      const remaining = current.filter((row) => row.category.id !== categoryId);
      const nextId = remaining[0]?.category.id ?? null;
      setSelectedId(nextId);
      window.history.replaceState(null, '', nextId ? `/item-categories?id=${nextId}` : '/item-categories');
      return remaining;
    });
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] min-h-0 flex-col overflow-hidden bg-background">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Item categories</h1>
          <p className="mt-1 text-xs text-foreground-subtle">
            Manage packaging categories, numbering, and item template defaults.
          </p>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New category
          </Button>
        )}
      </header>

      {actionError && (
        <div className="border-b border-border bg-destructive-subtle px-5 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-10">
          <div className="max-w-sm space-y-4 text-center">
            <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-surface text-foreground-muted">
              <Boxes className="size-7" />
            </div>
            <div className="space-y-1.5">
              <h2 className="text-lg font-semibold text-foreground">No categories yet</h2>
              <p className="text-sm text-foreground-muted">
                Create a category to organize items, set up auto-numbering, and define template defaults.
              </p>
            </div>
            {canManage && (
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" />
                New category
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-hidden p-3 lg:p-4">
          <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(280px,340px)_1fr] lg:gap-4">
            <aside className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface-raised card-shadow">
              <div className="border-b border-border p-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search categories"
                    className="pl-9"
                  />
                </div>
              </div>
              <ul className="flex-1 space-y-1 overflow-y-auto px-2 py-2">
                {filtered.length === 0 ? (
                  <li className="px-4 py-10 text-center text-sm text-foreground-muted">
                    No categories match “{search.trim()}”.
                  </li>
                ) : (
                  filtered.map(({ category }) => {
                    const isActive = category.id === selectedId;
                    return (
                      <li key={category.id}>
                        <button
                          type="button"
                          onClick={() => selectCategory(category.id)}
                          className={cn(
                            'flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left transition-colors',
                            isActive
                              ? 'bg-primary-subtle text-foreground blue-glow-sm'
                              : 'text-foreground hover:bg-surface',
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate font-medium">
                            {category.name} {numberingLabel(category)}
                          </span>
                          <CategoryBadge category={category} />
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            </aside>

            <div className="min-h-0 overflow-y-auto rounded-xl border border-border bg-surface-raised card-shadow p-4">
              {selectedRow ? (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-lg font-semibold text-foreground">{selectedRow.category.name}</h2>
                    {canManage && (
                      <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
                        <Trash2 className="size-4" />
                        Delete
                      </Button>
                    )}
                  </div>
                  <CategorySettingsBlock
                    key={selectedRow.category.id}
                    category={selectedRow.category}
                    canManage={canManage}
                    onSaved={updateRowCategory}
                  />
                  <CategoryNumberingBlock
                    key={`${selectedRow.category.id}-numbering`}
                    category={selectedRow.category}
                    canManage={canManage}
                    onSaved={updateRowCategory}
                  />
                  <CategoryTemplateBlock
                    key={`${selectedRow.category.id}-template`}
                    category={selectedRow.category}
                    template={selectedRow.template}
                    canManage={canManage}
                    references={references}
                    onSaved={(template) => updateRowTemplate(selectedRow.category.id, template)}
                  />
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-foreground-muted">
                  Select a category to view details.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <CreateCategoryDialog
        key={createOpen ? 'create-open' : 'create-closed'}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={handleCreated}
        onError={setActionError}
      />

      {selectedRow && (
        <DeleteCategoryDialog
          key={deleteOpen ? `delete-${selectedRow.category.id}-open` : "delete-closed"}
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          category={selectedRow.category}
          onDeleted={() => handleDeleted(selectedRow.category.id)}
          onError={setActionError}
        />
      )}
    </div>
  );
}

function CreateCategoryDialog({
  open,
  onOpenChange,
  onCreate,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (category: Category) => void;
  onError: (message: string | null) => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [isPending, startTransition] = useTransition();

  function handleCreate() {
    setError('');
    onError(null);
    startTransition(async () => {
      try {
        const category = await createItemCategory(name);
        setName('');
        onOpenChange(false);
        onCreate(category);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create category');
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New category</DialogTitle>
          <DialogDescription>Give the category a name. You can configure numbering and template defaults after creating it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="new-category-name" className="text-[11px] uppercase tracking-wide text-foreground-subtle">
              Name
            </Label>
            <Input
              id="new-category-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Category name"
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!name.trim() || isPending} onClick={handleCreate}>
            {isPending ? 'Creating…' : 'Create category'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteCategoryDialog({
  open,
  onOpenChange,
  category,
  onDeleted,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  category: Category;
  onDeleted: () => void;
  onError: (message: string | null) => void;
}) {
  const [itemCount, setItemCount] = useState<number | null>(null);
  const [countFailed, setCountFailed] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    getCategoryItemCount(category.id)
      .then(setItemCount)
      .catch(() => setCountFailed(true));
  }, [open, category.id]);

  function handleDelete() {
    onError(null);
    startTransition(async () => {
      try {
        await deleteItemCategory(category.id);
        onOpenChange(false);
        onDeleted();
      } catch (err) {
        onError(err instanceof Error ? err.message : 'Failed to delete category');
      }
    });
  }

  const countMessage = countFailed
    ? 'Items currently assigned to this category may be detached. The exact count could not be loaded.'
    : itemCount === null
      ? 'Checking how many items will be detached…'
      : itemCount > 0
        ? `${itemCount} item${itemCount === 1 ? '' : 's'} will be detached from this category (their category will be cleared, not deleted).`
        : 'No items are currently assigned to this category.';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete category</DialogTitle>
          <DialogDescription>
            This permanently deletes “{category.name}”. Items are not deleted — they are detached from
            the category.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground-muted">
          {countMessage}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={isPending || (itemCount === null && !countFailed)}
            onClick={handleDelete}
          >
            {isPending ? 'Deleting…' : 'Delete category'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
