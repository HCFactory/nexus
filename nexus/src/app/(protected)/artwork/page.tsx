'use client';

import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { canAccessArtworkWorkspace, resolveUserAccess } from '@/lib/auth/permissions';
import { Sidebar } from '@/components/layout';
import { PackagingForm, ItemStatusDropdown } from '@/components/packaging';
import { DropZone, UploadSessionCard, UploadProgress } from '@/components/uploads';
import { ItemWithCategory, User, UploadSessionWithDetails, UploadStatus, Category, ProductLine, ItemName } from '@/types/database';
import { createClient } from '@/lib/supabase/client';
import { CategoryBadge } from '@/components/ui';
import { formatDimensions } from '@/lib/utils/formatDimensions';
import { sanitizeFileName } from '@/lib/utils';
import { fetchSessionsClient } from '@/lib/utils/fetchSessions';
import {
  getItems,
  createItem,
  updateItem,
  deleteItem,
} from '@/app/actions/items';
import { getCategories } from '@/app/actions/categories';
import {
  getProductLines,
  createProductLine,
} from '@/app/actions/productLines';
import {
  getItemNames,
  createItemName,
  updateItemName,
} from '@/app/actions/itemNames';
import {
  createUploadSession,
  updateUploadSessionStatus,
  updateUploadSessionNotes,
  archiveUploadSession,
  deleteUploadSession,
} from '@/app/actions/uploads';
import { getCurrentUser } from '@/app/actions/users';

interface UploadingFile {
  file: File;
  progress: number;
  status: 'pending' | 'uploading' | 'complete' | 'error';
  error?: string;
}

async function sendEmailNotification(type: string, data: Record<string, unknown>): Promise<void> {
  try {
    await fetch('/api/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, data }),
    });
  } catch (e) {
    console.error('Failed to send email:', e);
  }
}

export default function HomePage() {
  const searchParams = useSearchParams();
  
  // Read URL param ONCE on mount - use ref to track if we've done initial load
  const initialUrlId = searchParams.get('id');
  const hasInitialized = useRef(false);
  const sessionRequestToken = useRef(0);

  const [user, setUser] = useState<User | null>(null);
  const [items, setItems] = useState<ItemWithCategory[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [productLines, setProductLines] = useState<ProductLine[]>([]);
  const [itemNames, setItemNames] = useState<ItemName[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<UploadSessionWithDetails[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [showArchivedUploads, setShowArchivedUploads] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState<ItemWithCategory | null>(null);
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);
  const [loading, setLoading] = useState(true);
  const access = resolveUserAccess(user);

  // Load data ONCE on mount - no dependencies that would cause re-runs
  useEffect(() => {
    async function loadData() {
      try {
        const userData = await getCurrentUser();
        setUser(userData);

        if (!userData?.organization_id) {
          setItems([]);
          setCategories([]);
          setProductLines([]);
          setItemNames([]);
          return;
        }

        const [itemsData, categoriesData, productLinesData, itemNamesData] = await Promise.all([
          getItems(),
          getCategories(),
          getProductLines(),
          getItemNames(),
        ]);
        setItems(itemsData);
        setCategories(categoriesData);
        setProductLines(productLinesData);
        setItemNames(itemNamesData);

        // Only set initial selection if we haven't already selected something
        if (!hasInitialized.current) {
          hasInitialized.current = true;
          if (initialUrlId && itemsData.some((i) => i.id === initialUrlId)) {
            setSelectedId(initialUrlId);
          } else if (itemsData.length > 0) {
            setSelectedId(itemsData[0].id);
          }
        }
      } catch (error) {
        console.error('Failed to load data:', error);
      } finally {
        setLoading(false);
      }
    }
    
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty deps - load once on mount only

  // Derive selectedItem synchronously from items array
  const selectedItem = selectedId ? items.find((i) => i.id === selectedId) || null : null;

  // Fetch sessions when selectedId changes, using request token for "latest wins"
  useEffect(() => {
    // Increment token on every selectedId change - this invalidates prior requests
    const currentToken = ++sessionRequestToken.current;
    
    if (!selectedId) {
      setSessions([]);
      setSessionsLoading(false);
      return;
    }

    // Immediately clear old sessions and show loading
    setSessions([]);
    setSessionsLoading(true);

    fetchSessionsClient(selectedId)
      .then((data) => {
        // Only update if this is still the latest request
        if (sessionRequestToken.current === currentToken) {
          setSessions(data);
          setSessionsLoading(false);
        }
      })
      .catch((error) => {
        // Only update if this is still the latest request
        if (sessionRequestToken.current === currentToken) {
          console.error('Failed to load sessions:', error);
          setSessionsLoading(false);
        }
      });
  }, [selectedId]);

  const handleSelect = (id: string) => {
    if (id === selectedId) return; // Don't reload if already selected
    setSelectedId(id);
    // Use history API directly to update URL without triggering Next.js navigation
    window.history.replaceState(null, '', `/artwork?id=${id}`);
  };

  const handleCreateProductLine = async (name: string): Promise<ProductLine> => {
    const newProductLine = await createProductLine(name);
    setProductLines((prev) => [...prev, newProductLine].sort((a, b) => a.name.localeCompare(b.name)));
    return newProductLine;
  };

  const handleCreateItemName = async (name: string): Promise<ItemName> => {
    const newItemName = await createItemName(name);
    setItemNames((prev) => [...prev, newItemName].sort((a, b) => a.name.localeCompare(b.name)));
    return newItemName;
  };

  const handleUpdateItemName = async (id: string, name: string): Promise<ItemName> => {
    const updatedItemName = await updateItemName(id, name);
    setItemNames((prev) => 
      prev.map((i) => (i.id === id ? updatedItemName : i)).sort((a, b) => a.name.localeCompare(b.name))
    );
    // Also update any items in the list that reference this item name
    setItems((prev) =>
      prev.map((item) =>
        item.item_name_id === id ? { ...item, item_name: updatedItemName } : item
      )
    );
    return updatedItemName;
  };

  const handleCategoryUpdated = (updatedCategory: Category) => {
    setCategories((prev) =>
      prev.map((c) => (c.id === updatedCategory.id ? updatedCategory : c))
    );
    // Update all items that use this category
    setItems((prev) =>
      prev.map((item) =>
        item.category_id === updatedCategory.id
          ? { ...item, category: updatedCategory }
          : item
      )
    );
  };

  const handleCreateItem = async (data: {
    item_name_id: string;
    category_id: string;
    product_line_id: string | null;
    version: string | null;
  }) => {
    const newItem = await createItem(data);
    setItems((prev) => [newItem, ...prev]);
    setSelectedId(newItem.id);
    setShowForm(false);
    window.history.replaceState(null, '', `/artwork?id=${newItem.id}`);
  };

  const handleUpdateItem = async (data: {
    item_name_id: string;
    category_id: string;
    product_line_id: string | null;
    version: string | null;
  }) => {
    if (!editingItem) return;
    const updated = await updateItem(editingItem.id, data);
    setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    setEditingItem(null);
  };

  const handleArchiveItem = async () => {
    if (!editingItem) return;
    const updated = await updateItem(editingItem.id, {
      archived: !editingItem.archived,
    });
    setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    setEditingItem(null);
  };

  const handleDeleteItem = async () => {
    if (!editingItem) return;
    if (!confirm('Are you sure you want to delete this packaging item? All uploads will also be deleted.')) {
      return;
    }
    await deleteItem(editingItem.id);
    setItems((prev) => prev.filter((i) => i.id !== editingItem.id));
    if (selectedId === editingItem.id) {
      const remaining = items.filter((i) => i.id !== editingItem.id);
      setSelectedId(remaining[0]?.id || null);
    }
    setEditingItem(null);
  };

  const handleFilesSelected = async (files: File[]) => {
    if (!selectedId || !selectedItem) return;

    const supabase = createClient();
    const uploadFiles: UploadingFile[] = files.map((file) => ({
      file,
      progress: 0,
      status: 'pending' as const,
    }));

    setUploadingFiles(uploadFiles);

    const uploadedFiles: { name: string; size: number; type: string; storagePath: string }[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setUploadingFiles((prev) =>
        prev.map((f, idx) => (idx === i ? { ...f, status: 'uploading' } : f))
      );

      const ext = '.' + file.name.split('.').pop()?.toLowerCase();
      const sanitizedName = sanitizeFileName(file.name);
      const storagePath = `${selectedId}/${Date.now()}_${sanitizedName}`;

      try {
        const { error } = await supabase.storage
          .from('packaging-files')
          .upload(storagePath, file);

        if (error) throw error;

        uploadedFiles.push({
          name: file.name,
          size: file.size,
          type: ext,
          storagePath,
        });

        setUploadingFiles((prev) =>
          prev.map((f, idx) =>
            idx === i ? { ...f, status: 'complete', progress: 100 } : f
          )
        );
      } catch (error) {
        setUploadingFiles((prev) =>
          prev.map((f, idx) =>
            idx === i
              ? { ...f, status: 'error', error: error instanceof Error ? error.message : 'Upload failed' }
              : f
          )
        );
      }
    }

    if (uploadedFiles.length > 0) {
      await createUploadSession(selectedId, uploadedFiles);

      // Fire-and-forget email notification (errors already handled inside)
      sendEmailNotification('new_upload', {
        packagingName: selectedItem.item_name?.name,
        packagingId: selectedId,
      });

      // Use token guard in case user navigated away during upload
      const tokenBeforeRefresh = sessionRequestToken.current;
      const updatedSessions = await fetchSessionsClient(selectedId);
      if (sessionRequestToken.current === tokenBeforeRefresh) {
        setSessions(updatedSessions);
      }

      // Refresh item data to get updated status (auto-transition from 'new' to 'in_progress')
      const refreshedItems = await getItems();
      setItems(refreshedItems);
    }

    setTimeout(() => setUploadingFiles([]), 2000);
  };

  const handleStatusChange = async (sessionId: string, status: UploadStatus) => {
    await updateUploadSessionStatus(sessionId, status);

    if (selectedItem) {
      await sendEmailNotification('status_change', {
        packagingName: selectedItem.item_name?.name,
        packagingId: selectedId,
        newStatus: status,
      });
    }

    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, status } : s))
    );
  };

  const handleNotesChange = async (sessionId: string, notes: string) => {
    await updateUploadSessionNotes(sessionId, notes);

    const session = sessions.find((s) => s.id === sessionId);
    const hadNotesBefore = session?.notes && session.notes.trim().length > 0;
    const hasNotesNow = notes.trim().length > 0;

    // Only send email if adding notes for the first time or significant change
    if (!hadNotesBefore && hasNotesNow && selectedItem) {
      await sendEmailNotification('note_added', {
        packagingName: selectedItem.item_name?.name,
        packagingId: selectedId,
        noteText: notes,
      });
    }

    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, notes } : s))
    );
  };

  const handleArchiveSession = async (sessionId: string, archived: boolean) => {
    await archiveUploadSession(sessionId, archived);
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, archived } : s))
    );
  };

  const handleDeleteSession = async (sessionId: string) => {
    await deleteUploadSession(sessionId);
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-foreground-muted">Loading...</div>
      </div>
    );
  }

  if (!user?.organization_id) {
    return (
      <main className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-sm">
          <svg className="w-12 h-12 mx-auto text-foreground-subtle mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
          </svg>
          <h2 className="text-lg font-semibold text-foreground mb-2">No organization assigned</h2>
          <p className="text-sm text-foreground-muted">
            Your account is not linked to an organization. Ask an administrator to assign you before using Artwork.
          </p>
        </div>
      </main>
    );
  }

  if (!canAccessArtworkWorkspace(access)) {
    return (
      <main className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-sm">
          <h2 className="text-lg font-semibold text-foreground mb-2">Artwork access required</h2>
          <p className="text-sm text-foreground-muted">
            Your current roles do not include access to the standalone artwork workspace.
          </p>
        </div>
      </main>
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden">
        <Sidebar
          items={items}
          selectedId={selectedId}
          onSelect={handleSelect}
          onCreateNew={() => setShowForm(true)}
          canCreateNew={access.canCreatePackagingItems}
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />

        <main className="flex-1 flex flex-col overflow-hidden">
          {selectedItem ? (
            <div key={selectedItem.id} className="flex flex-col flex-1 overflow-hidden">
              {/* Fixed header section */}
              <div className="flex items-start justify-between p-4 lg:p-6 pb-0 flex-shrink-0">
                <div>
                  <div className="flex items-center gap-3">
                    <h1 className="text-xl lg:text-2xl font-bold text-foreground">
                      {selectedItem.item_name?.name}
                    </h1>
                    {selectedItem.version && (
                      <span className="text-xl lg:text-2xl font-bold text-warning">
                        {selectedItem.version}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    {selectedItem.category ? (
                      <>
                        <CategoryBadge category={selectedItem.category} />
                        <span className="text-foreground-muted">
                          {formatDimensions(selectedItem.category.width, selectedItem.category.height, selectedItem.category.depth, selectedItem.category.unit)}
                        </span>
                      </>
                    ) : (
                      <span className="text-foreground-subtle italic">No category</span>
                    )}
                    {selectedItem.product_line && (
                      <>
                        <span className="text-foreground-subtle">·</span>
                        <span className="inline-block px-2 py-0.5 bg-purple-500/15 text-purple-400 text-sm font-medium rounded border border-purple-500/30">
                          {selectedItem.product_line.name}
                        </span>
                      </>
                    )}
                  </div>
                  {access.canViewArtworkFields && (
                    <div className="mt-2">
                      {access.canEditArtworkFields ? (
                        <ItemStatusDropdown
                          status={selectedItem.status}
                          onStatusChange={async (newStatus) => {
                            const updated = await updateItem(selectedItem.id, { status: newStatus });
                            setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
                          }}
                        />
                      ) : (
                        <span className="inline-flex px-2.5 py-1 rounded-full bg-surface text-foreground text-sm border border-border">
                          Artwork status: {selectedItem.status}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                {access.canEditPackagingItems && (
                  <button
                    onClick={() => setEditingItem(selectedItem)}
                    className="px-3 py-1.5 text-sm text-foreground-muted hover:text-foreground hover:bg-surface-raised rounded-md transition-colors"
                  >
                    Edit
                  </button>
                )}
              </div>

              {/* Scrollable content area */}
              <div className="flex-1 overflow-y-auto p-4 lg:p-6 pt-4">
                <div className="max-w-4xl">
                  <div className="mb-6">
                    <h2 className="text-lg font-semibold text-foreground mb-3">
                      Upload Files
                    </h2>
                    {access.canUploadArtworkFiles ? (
                      uploadingFiles.length > 0 ? (
                        <UploadProgress files={uploadingFiles} />
                      ) : (
                        <DropZone onFilesSelected={handleFilesSelected} />
                      )
                    ) : (
                      <div className="rounded-lg border border-dashed border-border p-4 text-sm text-foreground-muted">
                        This user can review artwork history but cannot upload new files.
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="text-lg font-semibold text-foreground">
                        Upload History
                      </h2>
                      {sessions.some(s => s.archived) && (
                        <label className="flex items-center gap-2 text-sm text-foreground-muted cursor-pointer">
                          <input
                            type="checkbox"
                            checked={showArchivedUploads}
                            onChange={(e) => setShowArchivedUploads(e.target.checked)}
                            className="rounded border-border text-primary focus:ring-primary"
                          />
                          Show archived
                        </label>
                      )}
                    </div>
                    {sessionsLoading ? (
                      <div className="bg-surface border border-border rounded-lg p-8 text-center">
                        <svg
                          className="w-8 h-8 mx-auto text-foreground-subtle animate-spin mb-4"
                          fill="none"
                          viewBox="0 0 24 24"
                        >
                          <circle
                            className="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"
                          />
                          <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                          />
                        </svg>
                        <p className="text-foreground-muted">Loading uploads...</p>
                      </div>
                    ) : sessions.filter(s => showArchivedUploads || !s.archived).length === 0 ? (
                      <div className="bg-surface border border-border rounded-lg p-8 text-center">
                        <svg
                          className="w-12 h-12 mx-auto text-foreground-subtle mb-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                          />
                        </svg>
                        <p className="text-foreground-muted">No uploads yet</p>
                        <p className="text-foreground-subtle text-sm mt-1">
                          Drag and drop files above to get started
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {sessions
                          .filter(s => showArchivedUploads || !s.archived)
                          .map((session) => (
                            <UploadSessionCard
                              key={session.id}
                              session={session}
                              onStatusChange={handleStatusChange}
                              onNotesChange={handleNotesChange}
                              onArchive={handleArchiveSession}
                              onDelete={handleDeleteSession}
                              canEditStatus={access.canEditUploadStatus}
                              canEditNotes={access.canEditUploadNotes}
                              canArchive={access.canArchiveUploadSessions}
                              canDelete={access.canDeleteUploadSessions}
                            />
                          ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full p-4 lg:p-6">
              <div className="text-center">
                <svg
                  className="w-16 h-16 mx-auto text-foreground-subtle mb-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                  />
                </svg>
                <h2 className="text-xl font-semibold text-foreground mb-2">
                  No Packaging Item Selected
                </h2>
                <p className="text-foreground-muted mb-4">
                  Select an item from the sidebar or create a new one
                </p>
                {access.canCreatePackagingItems && (
                  <button
                    onClick={() => setShowForm(true)}
                    className="px-4 py-2 bg-primary hover:bg-primary-hover text-primary-foreground rounded-md transition-colors"
                  >
                    Create New Item
                  </button>
                )}
              </div>
            </div>
          )}
        </main>

      {showForm && access.canCreatePackagingItems && (
        <PackagingForm
          categories={categories}
          productLines={productLines}
          itemNames={itemNames}
          onSubmit={handleCreateItem}
          onCancel={() => setShowForm(false)}
          onCategoryCreated={(newCategory) => {
            setCategories((prev) => [...prev, newCategory].sort((a, b) => a.name.localeCompare(b.name)));
          }}
          onCategoryUpdated={handleCategoryUpdated}
          onCreateProductLine={handleCreateProductLine}
          onCreateItemName={handleCreateItemName}
          onUpdateItemName={handleUpdateItemName}
        />
      )}

      {editingItem && access.canEditPackagingItems && (
        <PackagingForm
          item={editingItem}
          categories={categories}
          productLines={productLines}
          itemNames={itemNames}
          onSubmit={handleUpdateItem}
          onCancel={() => setEditingItem(null)}
          onCategoryCreated={(newCategory) => {
            setCategories((prev) => [...prev, newCategory].sort((a, b) => a.name.localeCompare(b.name)));
          }}
          onCategoryUpdated={handleCategoryUpdated}
          onCreateProductLine={handleCreateProductLine}
          onCreateItemName={handleCreateItemName}
          onUpdateItemName={handleUpdateItemName}
          onArchive={handleArchiveItem}
          onDelete={handleDeleteItem}
        />
      )}
    </div>
  );
}
