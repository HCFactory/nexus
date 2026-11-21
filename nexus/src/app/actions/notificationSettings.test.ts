import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, type FakeSupabase } from '@/test/fakeSupabase';

const mocks = vi.hoisted(() => ({
  access: { isAdmin: true, canViewReceivables: true } as { isAdmin: boolean; canViewReceivables: boolean },
  db: null as unknown as FakeSupabase,
  revalidate: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/auth/currentUserAccess', () => ({
  requireOrganizationContext: async () => ({ orgId: 'org-1', user: { id: 'u1' }, access: mocks.access }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mocks.db.client }));

import { getNotificationSettings, saveNotificationSettings } from './notificationSettings';

beforeEach(() => {
  vi.unstubAllEnvs();
  mocks.access = { isAdmin: true, canViewReceivables: true };
  mocks.db = fakeSupabase({ org_notification_settings: [] });
});

describe('getNotificationSettings', () => {
  it('nothing saved yet: no charge emails; saved-card shows the address it goes to today', async () => {
    expect(await getNotificationSettings()).toEqual({
      available: true,
      canEdit: true,
      backupChargeEmails: [],
      cardSavedEmails: ['fundraisers@hawaiicandyfactory.com'],
    });
  });

  it('read-only for staff who can view receivables but are not admins', async () => {
    mocks.access = { isAdmin: false, canViewReceivables: true };
    expect(await getNotificationSettings()).toMatchObject({ canEdit: false });
  });

  it('hidden (null) for staff without receivables access', async () => {
    mocks.access = { isAdmin: false, canViewReceivables: false };
    expect(await getNotificationSettings()).toBeNull();
  });

  it('migration not applied: unavailable', async () => {
    mocks.db.failOn = () => 'relation "org_notification_settings" does not exist';
    expect(await getNotificationSettings()).toMatchObject({ available: false });
  });
});

describe('saveNotificationSettings', () => {
  it('saves cleaned lists for this organization', async () => {
    const out = await saveNotificationSettings({
      backupChargeEmails: [' AR@Example.com', 'ar@example.com', 'boss@example.com'],
      cardSavedEmails: [],
    });
    expect(out).toEqual({ available: true, canEdit: true, backupChargeEmails: ['ar@example.com', 'boss@example.com'], cardSavedEmails: [] });
    expect(mocks.db.tables.org_notification_settings[0]).toMatchObject({
      organization_id: 'org-1',
      backup_charge_emails: ['ar@example.com', 'boss@example.com'],
      card_saved_emails: [],
      updated_by: 'u1',
    });
    expect(mocks.revalidate).toHaveBeenCalledWith('/settings');
  });

  it('refuses an invalid address and saves nothing', async () => {
    await expect(saveNotificationSettings({ backupChargeEmails: ['ok@example.com', 'nope'], cardSavedEmails: [] })).rejects.toThrow(
      'Not a valid email address: nope',
    );
    expect(mocks.db.tables.org_notification_settings).toEqual([]);
  });

  it('refuses more than 20 addresses in a list', async () => {
    const many = Array.from({ length: 21 }, (_, i) => `p${i}@example.com`);
    await expect(saveNotificationSettings({ backupChargeEmails: many, cardSavedEmails: [] })).rejects.toThrow(
      'At most 20 addresses per list.',
    );
  });

  it('only admins may save', async () => {
    mocks.access = { isAdmin: false, canViewReceivables: true };
    await expect(saveNotificationSettings({ backupChargeEmails: ['a@example.com'], cardSavedEmails: [] })).rejects.toThrow(
      'Only admins can change notification emails.',
    );
    expect(mocks.db.tables.org_notification_settings).toEqual([]);
  });

  it('rejects malformed input', async () => {
    await expect(saveNotificationSettings({ backupChargeEmails: 'a@example.com', cardSavedEmails: [] } as never)).rejects.toThrow(
      'Refresh the page and try again.',
    );
  });
});
