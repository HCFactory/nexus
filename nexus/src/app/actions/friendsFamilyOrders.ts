'use server';

import { revalidatePath } from 'next/cache';
import { requireOrganizationContext } from '@/lib/auth/currentUserAccess';
import { createClient } from '@/lib/supabase/server';
import type {
  FriendsFamilyFulfillmentStatus,
  FriendsFamilyOrder,
  FriendsFamilyOrderItem,
  FriendsFamilyOrderWithItems,
  FriendsFamilyPaymentStatus,
  FriendsFamilyProduct,
  FriendsFamilyWorkspace,
} from '@/types/database';

export interface CreateFriendsFamilyOrderInput {
  ordered_by: string;
  customer_name: string;
  phone?: string;
  email?: string;
  notes?: string;
  items: Array<{ product_id: string; quantity: number }>;
}

export interface FriendsFamilyProductInput {
  name: string;
  category: string;
  unit_price: number;
}

const FULFILLMENT_STATUSES = new Set<FriendsFamilyFulfillmentStatus>(['new', 'processing', 'fulfilled', 'cancelled']);
const PAYMENT_STATUSES = new Set<FriendsFamilyPaymentStatus>(['unpaid', 'paid', 'refunded']);

function requiredText(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function revalidateWorkspace() {
  revalidatePath('/friends-family');
}

export async function getFriendsFamilyWorkspace(): Promise<FriendsFamilyWorkspace> {
  const { orgId } = await requireOrganizationContext();
  const supabase = await createClient();
  const [{ data: products, error: productError }, { data: orders, error: orderError }] = await Promise.all([
    supabase
      .from('friends_family_products')
      .select('*')
      .eq('organization_id', orgId)
      .order('category')
      .order('name'),
    supabase
      .from('friends_family_orders')
      .select('*, order_items:friends_family_order_items(*)')
      .eq('organization_id', orgId)
      .order('order_sequence', { ascending: false }),
  ]);

  if (productError) throw productError;
  if (orderError) throw orderError;

  return {
    products: (products ?? []).map((product) => ({
      ...product,
      unit_price: Number(product.unit_price),
    })) as FriendsFamilyProduct[],
    orders: (orders ?? []).map((order) => {
      const row = order as FriendsFamilyOrder & { order_items: FriendsFamilyOrderItem[] };
      return {
        ...row,
        total_amount: Number(row.total_amount),
        items: (row.order_items ?? [])
          .map((item) => ({ ...item, unit_price: Number(item.unit_price), subtotal: Number(item.subtotal) }))
          .sort((a, b) => a.sort_order - b.sort_order),
        order_items: undefined,
      };
    }) as FriendsFamilyOrderWithItems[],
  };
}

export async function createFriendsFamilyOrder(input: CreateFriendsFamilyOrderInput): Promise<string> {
  await requireOrganizationContext();
  const supabase = await createClient();
  const orderedBy = requiredText(input.ordered_by, 'Ordered by');
  const customerName = requiredText(input.customer_name, 'Customer name');
  if (!input.items.length || input.items.some((item) => !item.product_id || !Number.isInteger(item.quantity) || item.quantity <= 0)) {
    throw new Error('Every order line requires a product and a whole-number quantity greater than zero');
  }

  const { data, error } = await supabase.rpc('create_friends_family_order', {
    p_ordered_by: orderedBy,
    p_customer_name: customerName,
    p_phone: input.phone?.trim() ?? '',
    p_email: input.email?.trim() ?? '',
    p_notes: input.notes?.trim() ?? '',
    p_items: input.items,
  });

  if (error) throw error;
  revalidateWorkspace();
  return data as string;
}

export async function updateFriendsFamilyOrder(
  orderId: string,
  input: CreateFriendsFamilyOrderInput
): Promise<void> {
  await requireOrganizationContext();
  const orderedBy = requiredText(input.ordered_by, 'Ordered by');
  const customerName = requiredText(input.customer_name, 'Customer name');
  if (!input.items.length || input.items.some((item) => !item.product_id || !Number.isInteger(item.quantity) || item.quantity <= 0)) {
    throw new Error('Every order line requires a product and a whole-number quantity greater than zero');
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc('update_friends_family_order', {
    p_order_id: orderId,
    p_ordered_by: orderedBy,
    p_customer_name: customerName,
    p_phone: input.phone?.trim() ?? '',
    p_email: input.email?.trim() ?? '',
    p_notes: input.notes?.trim() ?? '',
    p_items: input.items,
  });
  if (error) throw error;
  revalidateWorkspace();
}

export async function deleteFriendsFamilyOrder(orderId: string): Promise<void> {
  await requireOrganizationContext();
  const supabase = await createClient();
  const { error } = await supabase.rpc('delete_friends_family_order', { p_order_id: orderId });
  if (error) throw error;
  revalidateWorkspace();
}

export async function updateFriendsFamilyOrderStatus(
  orderId: string,
  patch: Partial<Pick<FriendsFamilyOrder, 'fulfillment_status' | 'payment_status'>>
): Promise<void> {
  const { orgId } = await requireOrganizationContext();
  const update: Partial<Pick<FriendsFamilyOrder, 'fulfillment_status' | 'payment_status'>> = {};
  if (patch.fulfillment_status) {
    if (!FULFILLMENT_STATUSES.has(patch.fulfillment_status)) throw new Error('Invalid fulfillment status');
    update.fulfillment_status = patch.fulfillment_status;
  }
  if (patch.payment_status) {
    if (!PAYMENT_STATUSES.has(patch.payment_status)) throw new Error('Invalid payment status');
    update.payment_status = patch.payment_status;
  }
  if (!Object.keys(update).length) return;

  const supabase = await createClient();
  const { error } = await supabase.from('friends_family_orders').update(update).eq('id', orderId).eq('organization_id', orgId);
  if (error) throw error;
  revalidateWorkspace();
}

async function requireFriendsFamilyAdmin() {
  const context = await requireOrganizationContext();
  if (!context.access.isAdmin) throw new Error('Administrator access is required to manage products');
  return context;
}

export async function createFriendsFamilyProduct(input: FriendsFamilyProductInput): Promise<FriendsFamilyProduct> {
  const { orgId, user } = await requireFriendsFamilyAdmin();
  const unitPrice = Number(input.unit_price);
  if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error('Unit price must be zero or greater');
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('friends_family_products')
    .insert({
      organization_id: orgId,
      name: requiredText(input.name, 'Product name'),
      category: requiredText(input.category, 'Category'),
      unit_price: unitPrice,
      created_by: user.id,
    })
    .select('*')
    .single();
  if (error || !data) throw error ?? new Error('Product could not be created');
  revalidateWorkspace();
  return { ...data, unit_price: Number(data.unit_price) } as FriendsFamilyProduct;
}

export async function updateFriendsFamilyProduct(
  productId: string,
  patch: Partial<Pick<FriendsFamilyProduct, 'name' | 'category' | 'unit_price' | 'active'>>
): Promise<FriendsFamilyProduct> {
  const { orgId } = await requireFriendsFamilyAdmin();
  const update: Record<string, string | number | boolean> = {};
  if (patch.name !== undefined) update.name = requiredText(patch.name, 'Product name');
  if (patch.category !== undefined) update.category = requiredText(patch.category, 'Category');
  if (patch.unit_price !== undefined) {
    if (!Number.isFinite(patch.unit_price) || patch.unit_price < 0) throw new Error('Unit price must be zero or greater');
    update.unit_price = patch.unit_price;
  }
  if (patch.active !== undefined) update.active = patch.active;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('friends_family_products')
    .update(update)
    .eq('id', productId)
    .eq('organization_id', orgId)
    .select('*')
    .single();
  if (error || !data) throw error ?? new Error('Product could not be updated');
  revalidateWorkspace();
  return { ...data, unit_price: Number(data.unit_price) } as FriendsFamilyProduct;
}
