import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Who gets staff notification emails (Settings > Receivables), stored per
 * organization in org_notification_settings (migration 077). Server code only:
 * the table has no RLS policy, so pass a service-role client.
 */

export const MAX_NOTIFY_EMAILS = 20;
/** Where the card-saved email went before the list could be edited. */
export const DEFAULT_CARD_SAVED_EMAIL = 'fundraisers@hawaiicandyfactory.com';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface NotificationSettings {
  /** False when the table can't be read (e.g. migration 077 not applied). */
  available: boolean;
  backupChargeEmails: string[];
  /** null = never set: the old fixed address is used. */
  cardSavedEmails: string[] | null;
}

/** Trimmed, lowercased, valid, unique; at most MAX_NOTIFY_EMAILS. Invalid entries are returned for the message. */
export function normalizeEmailList(raw: string[]): { emails: string[]; invalid: string[] } {
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const entry of raw) {
    const e = String(entry ?? '').trim().toLowerCase();
    if (!e) continue;
    if (!EMAIL.test(e)) invalid.push(String(entry).trim());
    else if (!emails.includes(e)) emails.push(e);
  }
  return { emails: emails.slice(0, MAX_NOTIFY_EMAILS), invalid };
}

const textList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Never throws: an unreadable table reads as "unavailable" with nobody to notify. */
export async function readNotificationSettings(supabase: SupabaseClient, orgId: string): Promise<NotificationSettings> {
  const { data, error } = await supabase
    .from('org_notification_settings')
    .select('backup_charge_emails, card_saved_emails')
    .eq('organization_id', orgId)
    .maybeSingle();
  if (error) {
    console.error(`[notifications] could not read the notification settings: ${error.message}`);
    return { available: false, backupChargeEmails: [], cardSavedEmails: null };
  }
  const row = data as { backup_charge_emails?: unknown; card_saved_emails?: unknown } | null;
  return {
    available: true,
    backupChargeEmails: textList(row?.backup_charge_emails),
    cardSavedEmails: row && Array.isArray(row.card_saved_emails) ? textList(row.card_saved_emails) : null,
  };
}

/** The saved list once someone saved it (even empty); before that, the old fixed address. */
export function cardSavedRecipients(settings: NotificationSettings): string[] {
  if (settings.cardSavedEmails) return settings.cardSavedEmails;
  return [process.env.CARD_SAVED_NOTIFY_EMAIL || DEFAULT_CARD_SAVED_EMAIL];
}

/** Writes the organization's row. Lists must already be normalized; permission is the caller's job. */
export async function saveNotificationSettingsRow(
  supabase: SupabaseClient,
  orgId: string,
  userId: string,
  lists: { backupChargeEmails: string[]; cardSavedEmails: string[] },
  now: Date,
): Promise<void> {
  const row = {
    organization_id: orgId,
    backup_charge_emails: lists.backupChargeEmails,
    card_saved_emails: lists.cardSavedEmails,
    updated_at: now.toISOString(),
    updated_by: userId,
  };
  const { error } = await supabase.from('org_notification_settings').upsert(row, { onConflict: 'organization_id' });
  if (error) throw new Error(`Could not save the notification settings: ${error.message}`);
}
