'use server';

import { revalidatePath } from 'next/cache';
import { createServiceClient } from '@/lib/supabase/server';
import { getCurrentUserAccessContext } from '@/lib/auth/currentUserAccess';
import { DEFAULT_PERMISSIONS, normalizeUserPermissions } from '@/lib/auth/permissions';
import { User, UserPermissions, UserRole } from '@/types/database';

interface UpdateUserAccessInput {
  role: UserRole;
  organizationId: string | null;
  permissions: UserPermissions | null;
}

async function requireManageUsersContext() {
  const context = await getCurrentUserAccessContext();
  if (!context || !context.access.canManageUsers) {
    throw new Error('Unauthorized: Admin access required');
  }

  if (!context.user.organization_id) {
    throw new Error('No organization found');
  }

  return context;
}

async function getManageableUserById(targetUserId: string): Promise<User> {
  const adminContext = await requireManageUsersContext();
  const serviceClient = await createServiceClient();

  const { data, error } = await serviceClient
    .from('users')
    .select('*')
    .eq('id', targetUserId)
    .single();

  if (error || !data) {
    throw new Error('User not found');
  }

  const targetUser = data as User;
  const manageableOrganizationIds = new Set([adminContext.user.organization_id, null]);
  if (!manageableOrganizationIds.has(targetUser.organization_id)) {
    throw new Error('Cannot manage users outside your organization');
  }

  return targetUser;
}

export async function getCurrentUser(): Promise<User | null> {
  const context = await getCurrentUserAccessContext();
  return context?.user ?? null;
}

export async function getAllUsers(): Promise<User[]> {
  const adminContext = await requireManageUsersContext();
  const serviceClient = await createServiceClient();

  const { data, error } = await serviceClient
    .from('users')
    .select('*')
    .or(`organization_id.eq.${adminContext.user.organization_id},organization_id.is.null`)
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  return (data || []) as User[];
}

export async function getAllUserEmails(): Promise<string[]> {
  const context = await getCurrentUserAccessContext();
  if (!context?.user.organization_id) {
    return [];
  }

  const serviceClient = await createServiceClient();
  const { data, error } = await serviceClient
    .from('users')
    .select('email')
    .eq('organization_id', context.user.organization_id);

  if (error) {
    throw error;
  }

  return data?.map((user) => user.email) ?? [];
}

export async function changeUserPassword(userId: string, newPassword: string): Promise<void> {
  await getManageableUserById(userId);

  const serviceClient = await createServiceClient();
  const { error } = await serviceClient.auth.admin.updateUserById(userId, {
    password: newPassword,
  });

  if (error) {
    throw error;
  }
}

export async function updateUserAccess(
  userId: string,
  input: UpdateUserAccessInput
): Promise<User> {
  const adminContext = await requireManageUsersContext();
  const targetUser = await getManageableUserById(userId);
  const serviceClient = await createServiceClient();

  if (
    input.organizationId !== null &&
    input.organizationId !== adminContext.user.organization_id
  ) {
    throw new Error('Admins can only assign users to their own organization');
  }
  if (userId === adminContext.user.id && input.organizationId === null) {
    throw new Error("You can't remove yourself from the organization.");
  }

  const permissions = normalizeUserPermissions(input.permissions ?? DEFAULT_PERMISSIONS);
  const permissionsVersion = (targetUser.permissions_version ?? 0) + 1;
  const permissionsUpdatedAt = new Date().toISOString();

  const { data, error } = await serviceClient
    .from('users')
    .update({
      role: input.role,
      organization_id: input.organizationId,
      permissions,
      permissions_version: permissionsVersion,
      permissions_updated_at: permissionsUpdatedAt,
      updated_at: permissionsUpdatedAt,
    })
    .eq('id', userId)
    .select('*')
    .single();

  if (error || !data) {
    throw error ?? new Error('Failed to update user access');
  }

  revalidatePath('/', 'layout');
  revalidatePath('/admin');
  revalidatePath('/orders');
  revalidatePath('/artwork');
  revalidatePath('/invoices');

  return data as User;
}
