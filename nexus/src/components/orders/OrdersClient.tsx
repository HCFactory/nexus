'use client';

import { useCallback, useState, useEffect, useLayoutEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

import { OrderBlock } from '@/components/orders';
import { resolveUserAccess } from '@/lib/auth/permissions';
import {
  Category,
  PurchaseOrderWithItems,
  OrderItemWithDetails,
  User,
  InvoiceOption,
  ItemName,
  PackagingItemCombo,
} from '@/types/database';
import { createClient } from '@/lib/supabase/client';
import { getCategories } from '@/app/actions/categories';
import { getItemNames } from '@/app/actions/itemNames';
import { createOrder, createOrderItem, getPackagingItemCombos } from '@/app/actions/orders';
import { usePropState } from '@/hooks/usePropState';

interface OrdersClientProps {
  initialUser: User | null;
  initialOrders: PurchaseOrderWithItems[];
  initialItemNames: ItemName[];
  initialCategories: Category[];
  initialPackagingItemCombos: PackagingItemCombo[];
  initialInvoiceOptions: InvoiceOption[];
}

export function OrdersClient({
  initialUser,
  initialOrders,
  initialItemNames,
  initialCategories,
  initialPackagingItemCombos,
  initialInvoiceOptions,
}: OrdersClientProps) {
  const [user] = useState<User | null>(initialUser);
  const [orders, setOrders] = usePropState<PurchaseOrderWithItems[]>(initialOrders);
  const [itemNames, setItemNames] = usePropState<ItemName[]>(initialItemNames);
  const [categories, setCategories] = usePropState<Category[]>(initialCategories);
  const [packagingItemCombos, setPackagingItemCombos] = usePropState<PackagingItemCombo[]>(initialPackagingItemCombos);
  const [invoiceOptions, setInvoiceOptions] = useState<InvoiceOption[]>(initialInvoiceOptions);
  const [artworkStatusMap, setArtworkStatusMap] = useState<Record<string, string>>({});
  const [itemStatusMap, setItemStatusMap] = useState<Record<string, string>>({});
  const [itemsIdLookup, setItemsIdLookup] = useState<Record<string, string>>({});
  const [creatingOrder, setCreatingOrder] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const pathname = usePathname();

  // Use refs to avoid re-creating the subscription on every orders change
  const ordersRef = useRef<PurchaseOrderWithItems[]>([]);
  const userRef = useRef<User | null>(null);
  const isMountedRef = useRef(true);
  const artworkStatusRequestRef = useRef(0);
  // Keep the refs current after each commit. A layout effect runs before every
  // passive effect (children's included), so effects below always see fresh values.
  useLayoutEffect(() => {
    ordersRef.current = orders;
    userRef.current = user;
  });

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refreshArtworkStatus = useCallback(async (allOrderItems: OrderItemWithDetails[], orgId: string) => {
    const requestId = ++artworkStatusRequestRef.current;
    const supabase = createClient();
    const combos = allOrderItems
      .map((oi) => ({
        ...oi,
        effectiveItemNameId: oi.item_name_id,
        effectiveCategoryId: oi.category_id,
      }))
      .filter((oi) => oi.effectiveItemNameId && oi.effectiveCategoryId);
    if (combos.length === 0 || !orgId) {
      if (isMountedRef.current && requestId === artworkStatusRequestRef.current) {
        setItemsIdLookup({});
        setItemStatusMap({});
        setArtworkStatusMap({});
      }
      return;
    }

    const { data: matchedItems, error: matchedItemsError } = await supabase
      .from('items')
      .select('id, item_name_id, category_id, version, status, archived, updated_at')
      .eq('organization_id', orgId)
      .order('archived', { ascending: true })
      .order('updated_at', { ascending: false });

    if (matchedItemsError) {
      console.error('Failed to load artwork approval statuses:', matchedItemsError);
      return;
    }
    if (!matchedItems) return;

    const lookup: Record<string, string> = {};
    const statusLookup: Record<string, string> = {};
    for (const combo of combos) {
      const match = (matchedItems as { id: string; item_name_id: string; category_id: string; version: string | null; status: string; archived: boolean; updated_at: string }[]).find(
        (i) =>
          i.item_name_id === combo.effectiveItemNameId &&
          i.category_id === combo.effectiveCategoryId &&
          (i.version ?? null) === (combo.version ?? null)
      );
      if (match) {
        const key = `${combo.effectiveItemNameId}|${combo.effectiveCategoryId}|${combo.version ?? ''}`;
        lookup[key] = match.id;
        statusLookup[match.id] = match.status;
      }
    }
    if (!isMountedRef.current || requestId !== artworkStatusRequestRef.current) return;

    setItemsIdLookup(lookup);
    setItemStatusMap(statusLookup);

    const itemIds = [...new Set(Object.values(lookup))];
    if (itemIds.length === 0) {
      if (isMountedRef.current && requestId === artworkStatusRequestRef.current) {
        setArtworkStatusMap({});
      }
      return;
    }

    const { data: sessions, error: sessionsError } = await supabase
      .from('upload_sessions')
      .select('packaging_id, status, uploaded_at')
      .in('packaging_id', itemIds)
      .order('uploaded_at', { ascending: false });

    if (sessionsError) {
      console.error('Failed to load artwork upload statuses:', sessionsError);
      return;
    }
    if (!sessions) return;

    const statusMap: Record<string, string> = {};
    for (const session of sessions as { packaging_id: string; status: string }[]) {
      if (!statusMap[session.packaging_id]) {
        statusMap[session.packaging_id] = session.status;
      }
    }
    if (!isMountedRef.current || requestId !== artworkStatusRequestRef.current) return;

    setArtworkStatusMap(statusMap);
  }, []);

  const refreshCurrentArtworkStatus = useCallback(() => {
    const allOrderItems = ordersRef.current.flatMap((o) => o.order_items);
    void refreshArtworkStatus(allOrderItems, userRef.current?.organization_id ?? '');
  }, [refreshArtworkStatus]);

  useEffect(() => {
    refreshCurrentArtworkStatus();
  }, [orders, refreshCurrentArtworkStatus, user?.organization_id]);

  useEffect(() => {
    if (pathname !== '/orders') {
      return;
    }

    refreshCurrentArtworkStatus();

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'hidden') {
        return;
      }

      refreshCurrentArtworkStatus();
    };

    window.addEventListener('focus', refreshWhenVisible);
    window.addEventListener('pageshow', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);

    return () => {
      window.removeEventListener('focus', refreshWhenVisible);
      window.removeEventListener('pageshow', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [pathname, refreshCurrentArtworkStatus]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel('orders-upload-sessions')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'upload_sessions' },
        refreshCurrentArtworkStatus
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'items' },
        refreshCurrentArtworkStatus
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [refreshCurrentArtworkStatus]);

  const handleCreateOrder = async () => {
    setCreatingOrder(true);
    try {
      const newOrder = await createOrder();
      const firstItem = await createOrderItem(newOrder.id);
      const orderWithItems: PurchaseOrderWithItems = { ...newOrder, order_items: [firstItem] };
      setOrders((prev) => [orderWithItems, ...prev]);
    } catch (error) {
      console.error('Failed to create order:', error);
      alert('Failed to create order. Make sure your organization is set up.');
    } finally {
      setCreatingOrder(false);
    }
  };

  const handleDeleteOrder = (orderId: string) => {
    setOrders((prev) => prev.filter((o) => o.id !== orderId));
  };

  const handleArchiveOrder = (orderId: string) => {
    setOrders((prev) =>
      prev.map((o) => (o.id === orderId ? { ...o, archived: !o.archived } : o))
    );
  };

  const handleOrderItemsChange = (orderId: string, items: OrderItemWithDetails[]) => {
    setOrders((prev) => {
      const newOrders = prev.map((o) => (o.id === orderId ? { ...o, order_items: items } : o));
      // Compute allOrderItems from the new state, not the stale closure
      const allOrderItems = newOrders.flatMap((o) => o.order_items);
      refreshArtworkStatus(allOrderItems, user?.organization_id ?? '');
      return newOrders;
    });
  };

  if (!user) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-foreground-muted">Not authenticated</div>
      </div>
    );
  }

  const access = resolveUserAccess(user);

  if (!user.organization_id) {
    return (
      <main className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-sm">
            <svg className="w-12 h-12 mx-auto text-foreground-subtle mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
            <h2 className="text-lg font-semibold text-foreground mb-2">No organization assigned</h2>
            <p className="text-sm text-foreground-muted">Your account is not linked to an organization. Ask your administrator to assign you to one before using Purchase Orders.</p>
          </div>
      </main>
    );
  }
  return (
    <main className="flex-1 overflow-y-auto px-2 py-4 lg:p-6">
        <div>
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-xl lg:text-2xl font-bold text-foreground">Purchase Orders</h1>
            <div className="flex items-center gap-4">
              {orders.some((o) => o.archived) && (
                <label className="flex items-center gap-2 text-sm text-foreground-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showArchived}
                    onChange={(e) => setShowArchived(e.target.checked)}
                    className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
                  />
                  Show archived
                </label>
              )}
              {access.canCreateOrder && (
                <button
                  onClick={handleCreateOrder}
                  disabled={creatingOrder}
                  className="px-4 py-2 bg-primary hover:bg-primary-hover disabled:opacity-50 text-primary-foreground text-sm font-medium rounded-md transition-colors"
                >
                  {creatingOrder ? 'Creating...' : '+ Create New Order'}
                </button>
              )}
            </div>
          </div>

          {orders.length === 0 ? (
            <div className="bg-surface border border-border rounded-lg p-12 text-center">
              <svg className="w-16 h-16 mx-auto text-foreground-subtle mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              <h2 className="text-xl font-semibold text-foreground mb-2">No orders yet</h2>
              <p className="text-foreground-muted mb-4">Create your first purchase order to get started.</p>
              {access.canCreateOrder && (
                <button
                  onClick={handleCreateOrder}
                  className="px-4 py-2 bg-primary hover:bg-primary-hover text-primary-foreground text-sm font-medium rounded-md transition-colors"
                >
                  Create New Order
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {orders.filter((o) => showArchived || !o.archived).map((order) => (
                <OrderBlock
                  key={order.id}
                  order={order}
                  itemNames={itemNames}
                  categories={categories}
                  packagingItemCombos={packagingItemCombos}
                  onItemNamesChange={setItemNames}
                  onCategoriesListChange={setCategories}
                  onPackagingItemCombosChange={setPackagingItemCombos}
                  access={access}
                  invoiceOptions={invoiceOptions}
                  onInvoiceOptionsChange={setInvoiceOptions}
                  artworkStatusMap={artworkStatusMap}
                  itemStatusMap={itemStatusMap}
                  itemsIdLookup={itemsIdLookup}
                  onDelete={handleDeleteOrder}
                  onArchive={handleArchiveOrder}
                  onOrderItemsChange={handleOrderItemsChange}
                  onCatalogOptionsChange={async () => {
                    const [updatedItemNames, updatedCategories, updatedPackagingItemCombos] = await Promise.all([
                      getItemNames(),
                      getCategories(),
                      getPackagingItemCombos(),
                    ]);
                    setItemNames(updatedItemNames);
                    setCategories(updatedCategories);
                    setPackagingItemCombos(updatedPackagingItemCombos);
                  }}
                />
              ))}
            </div>
          )}
        </div>
    </main>
  );
}
