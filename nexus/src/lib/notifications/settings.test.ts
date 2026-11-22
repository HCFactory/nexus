import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase } from '@/test/fakeSupabase';
import { cardSavedRecipients, normalizeEmailList, readNotificationSettings, saveNotificationSettingsRow } from './settings';

afterEach(() => vi.unstubAllEnvs());

describe('normalizeEmailList', () => {
  it('trims, lowercases and drops duplicates and blanks', () => {
    expect(normalizeEmailList([' Lani@Example.com ', 'lani@example.com', '', 'ar@example.com'])).toEqual({
      emails: ['lani@example.com', 'ar@example.com'],
      invalid: [],
    });
  });

  it('lists addresses that are not valid', () => {
    expect(normalizeEmailList(['ok@example.com', 'not-an-email', 'a@b'])).toEqual({
      emails: ['ok@example.com'],
      invalid: ['not-an-email', 'a@b'],
    });
  });

  it('keeps at most 20', () => {
    const many = Array.from({ length: 25 }, (_, i) => `p${i}@example.com`);
    expect(normalizeEmailList(many).emails).toHaveLength(20);
  });
});

describe('readNotificationSettings', () => {
  it('no row yet: nobody for charges, the saved-card list never set', async () => {
    const db = fakeSupabase({ org_notification_settings: [] });
    expect(await readNotificationSettings(db.client, 'org-1')).toEqual({
      available: true,
      problem: null,
      backupChargeEmails: [],
      cardSavedEmails: null,
    });
  });

  it("reads this organization's row only", async () => {
    const db = fakeSupabase({
      org_notification_settings: [
        { organization_id: 'org-2', backup_charge_emails: ['other@example.com'], card_saved_emails: [] },
        { organization_id: 'org-1', backup_charge_emails: ['ar@example.com'], card_saved_emails: ['cs@example.com'] },
      ],
    });
    expect(await readNotificationSettings(db.client, 'org-1')).toEqual({
      available: true,
      problem: null,
      backupChargeEmails: ['ar@example.com'],
      cardSavedEmails: ['cs@example.com'],
    });
  });

  it('table missing (migration not applied): unavailable, never throws', async () => {
    const db = fakeSupabase({});
    db.failOn = () => ({ message: 'relation "org_notification_settings" does not exist', code: '42P01' });
    expect(await readNotificationSettings(db.client, 'org-1')).toEqual({
      available: false,
      problem: 'not_applied',
      backupChargeEmails: [],
      cardSavedEmails: null,
    });
  });

  it('any other read error: unavailable, but not blamed on the migration', async () => {
    const db = fakeSupabase({});
    db.failOn = () => ({ message: 'fetch failed' });
    expect(await readNotificationSettings(db.client, 'org-1')).toMatchObject({ available: false, problem: 'error' });
  });
});

describe('cardSavedRecipients', () => {
  it('never set: the old address (env, else the default)', () => {
    expect(cardSavedRecipients({ available: true, problem: null, backupChargeEmails: [], cardSavedEmails: null })).toEqual([
      'fundraisers@hawaiicandyfactory.com',
    ]);
    vi.stubEnv('CARD_SAVED_NOTIFY_EMAIL', 'env@example.com');
    expect(cardSavedRecipients({ available: false, problem: 'error', backupChargeEmails: [], cardSavedEmails: null })).toEqual(['env@example.com']);
  });

  it('a saved list wins, even when empty', () => {
    expect(cardSavedRecipients({ available: true, problem: null, backupChargeEmails: [], cardSavedEmails: ['cs@example.com'] })).toEqual([
      'cs@example.com',
    ]);
    expect(cardSavedRecipients({ available: true, problem: null, backupChargeEmails: [], cardSavedEmails: [] })).toEqual([]);
  });
});

describe('saveNotificationSettingsRow', () => {
  it('creates, then replaces, the organization row', async () => {
    const db = fakeSupabase({ org_notification_settings: [] });
    const now = new Date('2026-11-21T20:00:00Z');
    await saveNotificationSettingsRow(db.client, 'org-1', 'u1', { backupChargeEmails: ['a@example.com'], cardSavedEmails: [] }, now);
    await saveNotificationSettingsRow(db.client, 'org-1', 'u2', { backupChargeEmails: ['b@example.com'], cardSavedEmails: ['c@example.com'] }, now);
    // (the fake adds an id column; the real table has none)
    expect(db.tables.org_notification_settings.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'id')))).toEqual([
      {
        organization_id: 'org-1',
        backup_charge_emails: ['b@example.com'],
        card_saved_emails: ['c@example.com'],
        updated_at: now.toISOString(),
        updated_by: 'u2',
      },
    ]);
  });

  it('a database error is reported', async () => {
    const db = fakeSupabase({ org_notification_settings: [] });
    db.failOn = () => 'boom';
    await expect(
      saveNotificationSettingsRow(db.client, 'org-1', 'u1', { backupChargeEmails: [], cardSavedEmails: [] }, new Date()),
    ).rejects.toThrow('Could not save the notification settings: boom');
  });
});
