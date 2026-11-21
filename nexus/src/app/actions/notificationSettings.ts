'use server';

import { revalidatePath } from 'next/cache';

import { requireOrganizationContext } from '@/lib/auth/currentUserAccess';
import {
  MAX_NOTIFY_EMAILS,
  cardSavedRecipients,
  normalizeEmailList,
  readNotificationSettings,
  saveNotificationSettingsRow,
} from '@/lib/notifications/settings';
import { createServiceClient } from '@/lib/supabase/server';

// NOTE: only async functions are exported here.

interface NotificationSettingsView {
  /** False until migration 077 is applied, or when the read failed (see problem). */
  available: boolean;
  problem: 'not_applied' | 'error' | null;
  canEdit: boolean;
  backupChargeEmails: string[];
  /** Who it goes to today (the old address until someone saves the list). */
  cardSavedEmails: string[];
}

const NOT_ADMIN = 'Only admins can change notification emails.';

/** Settings > Receivables. null = hidden (no receivables access). */
export async function getNotificationSettings(): Promise<NotificationSettingsView | null> {
  const ctx = await requireOrganizationContext();
  if (!ctx.access.isAdmin && !ctx.access.canViewReceivables) return null;
  const settings = await readNotificationSettings(createServiceClient(), ctx.orgId);
  return {
    available: settings.available,
    problem: settings.problem,
    canEdit: Boolean(ctx.access.isAdmin),
    backupChargeEmails: settings.backupChargeEmails,
    cardSavedEmails: cardSavedRecipients(settings),
  };
}

export async function saveNotificationSettings(input: {
  backupChargeEmails: string[];
  cardSavedEmails: string[];
}): Promise<NotificationSettingsView> {
  const ctx = await requireOrganizationContext();
  if (!ctx.access.isAdmin) throw new Error(NOT_ADMIN);
  const isList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (!isList(input?.backupChargeEmails) || !isList(input?.cardSavedEmails)) throw new Error('Refresh the page and try again.');

  const clean = (raw: string[]) => {
    const { emails, invalid } = normalizeEmailList(raw);
    if (invalid.length > 0) throw new Error(`Not a valid email address: ${invalid.join(', ')}`);
    if (new Set(raw.map((e) => e.trim().toLowerCase()).filter(Boolean)).size > MAX_NOTIFY_EMAILS) {
      throw new Error(`At most ${MAX_NOTIFY_EMAILS} addresses per list.`);
    }
    return emails;
  };
  const lists = { backupChargeEmails: clean(input.backupChargeEmails), cardSavedEmails: clean(input.cardSavedEmails) };

  await saveNotificationSettingsRow(createServiceClient(), ctx.orgId, ctx.user.id as string, lists, new Date());
  revalidatePath('/settings');
  return { available: true, problem: null, canEdit: true, ...lists };
}
