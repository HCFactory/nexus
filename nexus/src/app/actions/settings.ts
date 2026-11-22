'use server';

import { requireOrganizationContext } from '@/lib/auth/currentUserAccess';
import { createClient } from '@/lib/supabase/server';

const MAX_RECENT_COLORS = 15;

async function getOrgId(): Promise<string> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data, error } = await supabase
    .from('users')
    .select('organization_id')
    .eq('id', user.id)
    .single();

  if (error || !data?.organization_id) throw new Error('No organization found');
  return data.organization_id;
}

export async function getRecentCustomColors(): Promise<string[]> {
  const supabase = await createClient();
  const orgId = await getOrgId();
  const key = `recent_custom_colors_${orgId}`;

  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', key)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return []; // Not found
    throw error;
  }

  return (data?.value as string[]) || [];
}

export async function addRecentCustomColor(hexColor: string): Promise<string[]> {
  const supabase = await createClient();
  const orgId = await getOrgId();
  const key = `recent_custom_colors_${orgId}`;

  // Get current colors
  const currentColors = await getRecentCustomColors();

  // Remove if already exists (to move to front)
  const filtered = currentColors.filter((c) => c.toLowerCase() !== hexColor.toLowerCase());

  // Add to front
  const newColors = [hexColor, ...filtered].slice(0, MAX_RECENT_COLORS);

  // Upsert the setting
  const { error } = await supabase
    .from('app_settings')
    .upsert(
      {
        key,
        value: newColors,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'key' }
    );

  if (error) throw error;

  return newColors;
}

/** Order Number Format (Settings). Admins only: returns null for everyone else, so the card is hidden. */
export async function getOrgOrderSettings(): Promise<{ order_prefix: string; order_padding: number } | null> {
  const { orgId, access } = await requireOrganizationContext();
  if (!access.isAdmin) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('org_order_settings')
    .select('order_prefix, order_padding')
    .eq('organization_id', orgId)
    .maybeSingle();

  if (error) throw error;
  return data ?? { order_prefix: 'PO', order_padding: 5 };
}

export async function upsertOrgOrderSettings(data: {
  order_prefix: string;
  order_padding: number;
}): Promise<void> {
  const { orgId, access } = await requireOrganizationContext();
  if (!access.isAdmin) throw new Error('Only admins can change the order number format.');

  const supabase = await createClient();
  const { error } = await supabase
    .from('org_order_settings')
    .upsert({
      organization_id: orgId,
      order_prefix: data.order_prefix.trim().toUpperCase(),
      order_padding: Math.max(1, Math.min(10, data.order_padding)),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'organization_id' });

  if (error) throw error;
}
