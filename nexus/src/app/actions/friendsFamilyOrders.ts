'use server';

import { revalidatePath } from 'next/cache';
import { getCurrentUserAccessContext, requireOrganizationContext } from '@/lib/auth/currentUserAccess';
import { FRIENDS_FAMILY_PRODUCT_COLORS } from '@/lib/friendsFamily/productColors';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import type {
  FriendsFamilyFulfillmentStatus,
  FriendsFamilyOrder,
  FriendsFamilyOrderItem,
  FriendsFamilyOrderWithItems,
  FriendsFamilyPaymentStatus,
  FriendsFamilyProduct,
  FriendsFamilyProductColor,
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

export interface CreatedFriendsFamilyOrder {
  id: string;
  orderNumber: string;
}

export interface FriendsFamilyProductInput {
  name: string;
  category: string;
  unit_price: number;
  color_key: FriendsFamilyProductColor;
}

const FULFILLMENT_STATUSES = new Set<FriendsFamilyFulfillmentStatus>(['new', 'packed', 'fulfilled']);
const PAYMENT_STATUSES = new Set<FriendsFamilyPaymentStatus>(['unpaid', 'cash_paid', 'square_paid', 'venmo_paid']);
const PRODUCT_COLORS = new Set<FriendsFamilyProductColor>(FRIENDS_FAMILY_PRODUCT_COLORS.map((color) => color.value));

function requiredText(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function revalidateWorkspace() {
  revalidatePath('/fnforders');
  revalidatePath('/friends-family-order-form');
}

async function getPublicFriendsFamilyOrganizationId(): Promise<string> {
  const configuredOrganizationId = process.env.FRIENDS_FAMILY_ORGANIZATION_ID?.trim();
  if (configuredOrganizationId) return configuredOrganizationId;

  const serviceClient = createServiceClient();
  const { data, error } = await serviceClient.from('organizations').select('id').limit(2);
  if (error) throw error;
  if (data?.length === 1) return data[0].id;

  throw new Error(
    'Set FRIENDS_FAMILY_ORGANIZATION_ID before using public Friends & Family pages in a multi-organization database'
  );
}

async function getWorkspaceDataContext() {
  const currentUser = await getCurrentUserAccessContext();
  if (currentUser?.user.organization_id) {
    return {
      orgId: currentUser.user.organization_id,
      supabase: await createClient(),
      isAuthenticatedMember: true,
    };
  }

  return {
    orgId: await getPublicFriendsFamilyOrganizationId(),
    supabase: createServiceClient(),
    isAuthenticatedMember: false,
  };
}

function validateOrderInput(input: CreateFriendsFamilyOrderInput) {
  const orderedBy = requiredText(input.ordered_by, 'Ordered by');
  const customerName = requiredText(input.customer_name, 'Customer name');
  if (orderedBy.length > 200 || customerName.length > 200) {
    throw new Error('Names must be 200 characters or fewer');
  }
  if (input.items.length > 50) throw new Error('Orders can contain at most 50 line items');
  if (!input.items.length || input.items.some((item) => !item.product_id || !Number.isInteger(item.quantity) || item.quantity <= 0)) {
    throw new Error('Every order line requires a product and a whole-number quantity greater than zero');
  }
  return { orderedBy, customerName };
}

export async function getFriendsFamilyWorkspace(): Promise<FriendsFamilyWorkspace> {
  const { orgId, supabase } = await getWorkspaceDataContext();
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

export async function createFriendsFamilyOrder(input: CreateFriendsFamilyOrderInput): Promise<CreatedFriendsFamilyOrder> {
  const { orderedBy, customerName } = validateOrderInput(input);
  const { orgId, supabase, isAuthenticatedMember } = await getWorkspaceDataContext();

  const { data, error } = await supabase.rpc(
    isAuthenticatedMember ? 'create_friends_family_order' : 'create_public_friends_family_order',
    {
      ...(isAuthenticatedMember ? {} : { p_organization_id: orgId }),
      p_ordered_by: orderedBy,
      p_customer_name: customerName,
      p_phone: input.phone?.trim() ?? '',
      p_email: input.email?.trim() ?? '',
      p_notes: input.notes?.trim() ?? '',
      p_items: input.items,
    }
  );

  if (error || !data) throw error ?? new Error('Order could not be created');
  const { data: createdOrder, error: createdOrderError } = await supabase
    .from('friends_family_orders')
    .select('order_number')
    .eq('id', data as string)
    .eq('organization_id', orgId)
    .single();
  if (createdOrderError || !createdOrder) throw createdOrderError ?? new Error('Order number could not be loaded');
  revalidateWorkspace();
  return { id: data as string, orderNumber: createdOrder.order_number };
}

export async function updateFriendsFamilyOrder(
  orderId: string,
  input: CreateFriendsFamilyOrderInput
): Promise<void> {
  const { orderedBy, customerName } = validateOrderInput(input);
  const { orgId, supabase, isAuthenticatedMember } = await getWorkspaceDataContext();
  const { error } = await supabase.rpc(
    isAuthenticatedMember ? 'update_friends_family_order' : 'update_public_friends_family_order',
    {
      ...(isAuthenticatedMember ? {} : { p_organization_id: orgId }),
      p_order_id: orderId,
      p_ordered_by: orderedBy,
      p_customer_name: customerName,
      p_phone: input.phone?.trim() ?? '',
      p_email: input.email?.trim() ?? '',
      p_notes: input.notes?.trim() ?? '',
      p_items: input.items,
    }
  );
  if (error) throw error;
  revalidateWorkspace();
}

export async function deleteFriendsFamilyOrder(orderId: string): Promise<void> {
  const { orgId, supabase, isAuthenticatedMember } = await getWorkspaceDataContext();
  const { error } = await supabase.rpc(
    isAuthenticatedMember ? 'delete_friends_family_order' : 'delete_public_friends_family_order',
    {
      ...(isAuthenticatedMember ? {} : { p_organization_id: orgId }),
      p_order_id: orderId,
    }
  );
  if (error) throw error;
  revalidateWorkspace();
}

export async function updateFriendsFamilyOrderStatus(
  orderId: string,
  patch: Partial<Pick<FriendsFamilyOrder, 'fulfillment_status' | 'payment_status'>>
): Promise<void> {
  const { orgId, supabase } = await getWorkspaceDataContext();
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
  if (!PRODUCT_COLORS.has(input.color_key)) throw new Error('Invalid product color');
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('friends_family_products')
    .insert({
      organization_id: orgId,
      name: requiredText(input.name, 'Product name'),
      category: requiredText(input.category, 'Category'),
      unit_price: unitPrice,
      color_key: input.color_key,
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
  patch: Partial<Pick<FriendsFamilyProduct, 'name' | 'category' | 'unit_price' | 'color_key' | 'active'>>
): Promise<FriendsFamilyProduct> {
  const { orgId } = await requireFriendsFamilyAdmin();
  const update: Record<string, string | number | boolean> = {};
  if (patch.name !== undefined) update.name = requiredText(patch.name, 'Product name');
  if (patch.category !== undefined) update.category = requiredText(patch.category, 'Category');
  if (patch.unit_price !== undefined) {
    if (!Number.isFinite(patch.unit_price) || patch.unit_price < 0) throw new Error('Unit price must be zero or greater');
    update.unit_price = patch.unit_price;
  }
  if (patch.color_key !== undefined) {
    if (!PRODUCT_COLORS.has(patch.color_key)) throw new Error('Invalid product color');
    update.color_key = patch.color_key;
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
