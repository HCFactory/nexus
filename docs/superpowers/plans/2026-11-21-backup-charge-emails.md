# Backup Payment Notification Emails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff manage, in Settings > Receivables, who gets an email when a backup card charge succeeds and when a customer saves a card.

**Architecture:** Migration 077 adds `org_notification_settings` and `card_payments.charge_email_sent_at`. A notifications module reads the lists and sends the email; the charge flow calls it (injected) after the processing → succeeded transition is won. The card-saved email reads its list from the same table. Admin-only server actions back a Settings card.

**Tech Stack:** Next.js 16, Supabase, Resend, Vitest + fakeSupabase.

**Spec:** docs/superpowers/specs/2026-11-21-backup-charge-emails-design.md

## Global Constraints

- Email failure never fails or undoes a charge; log only.
- One email per charge: claim `charge_email_sent_at` (update where null) before sending.
- `card_saved_emails` null = never set → old address (CARD_SAVED_NOTIFY_EMAIL || fundraisers@hawaiicandyfactory.com); [] = nobody.
- Lists: trimmed, lowercased, valid, de-duplicated, max 20.
- Before 077 is applied: settings read reports unavailable; charges send nothing; card-saved uses the old address.
- Sender: CUSTOMER_EMAIL_FROM via Resend.

## Review Focus

1. Bill.com step throws after Stripe succeeded → email still sent (with the warning).
2. Late charge (row was failed, Stripe later succeeded) → email sent once, with the warning.
3. Retry / Check status after success → no second email.
4. Table/column missing → charge unaffected, no crash.
5. Non-admin calling the save action → refused.

---

### Task 1: Migration 077
- [ ] `077_notification_settings.sql`: table (organization_id pk fk, backup_charge_emails text[] not null default '{}', card_saved_emails text[] null, updated_at, updated_by), RLS select for org members; `alter table card_payments add column if not exists charge_email_sent_at timestamptz`. Commit; user applies.

### Task 2: Settings module
**Create** `src/lib/notifications/settings.ts`:
- `normalizeEmailList(raw: string[]): { emails: string[]; invalid: string[] }`
- `readNotificationSettings(supabase, orgId): Promise<{ available: boolean; backupChargeEmails: string[]; cardSavedEmails: string[] | null }>`
- `cardSavedRecipients(settings): string[]` (null → old default)
- [ ] Tests: normalize (trim, lowercase, dedupe, invalid listed, cap 20); read missing row → defaults available; read error → unavailable; recipients null → default, [] → none.

### Task 3: Charge email
**Create** `src/lib/notifications/backupChargeEmail.ts`:
- `buildBackupChargeEmail(input): { subject; text }`
- `notifyBackupCharge(deps: { supabase; orgId; now; send; appUrl }, cardPaymentId): Promise<void>` (never throws)
**Modify** `chargeInvoice.ts`: `ChargeDeps.notifyCharged?: (cardPaymentId: string) => Promise<void>`; call after the won transition (after the Bill.com step, even if it threw) and after a late-charge transition. Wire in `actions/cardPayments.ts`.
- [ ] Tests: email content (invoice, amount, customer, card, who, Bill.com line); no recipients → no send, no claim; claimed already → no send; claim fails (column missing) → no send; send throws → no throw; chargeInvoice calls notify once on success, also when Bill.com throws, not on decline, not on retry.

### Task 4: Card-saved recipients
**Modify** `email.ts` (`sendCardSavedNotification` takes `to: string[]`; shared `sendStaffEmail`), `saveCard.ts` (recipients from settings).
- [ ] Tests: settings list used; null → old default; [] → no send.

### Task 5: Actions + Settings UI
**Create** `src/app/actions/notificationSettings.ts` (`getNotificationSettings`, `saveNotificationSettings` admin-only), `src/components/settings/ReceivablesNotificationsCard.tsx`; add to settings page.
- [ ] Tests: card renders lists, add/remove, save calls action, invalid address message, unavailable note, read-only for non-admin. Browser check.

### Task 6: Verify
- [ ] Full suite, tsc, lint; fresh reviewer; fix; ask before pushing.
