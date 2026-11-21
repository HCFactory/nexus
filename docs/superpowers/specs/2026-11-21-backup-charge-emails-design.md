# Backup payment notification emails: design (short)

## Intent

Staff want an email whenever a customer's backup card (saved Stripe card) is charged successfully, sent to addresses they manage in Settings, not in server config. The existing "customer saved a card" staff email moves to the same place so its addresses can be edited too.

## Goals

1. **Settings, new "Receivables" section:**
   - "Backup payment charged": list of email addresses;
   - "Backup payment method saved": list of email addresses.
   - Add or remove an address, then press Save. Admins edit; everyone else sees the section read-only (or it is hidden for those without receivables access).
2. **Charge-succeeded email:** sent after a successful backup card charge, once Nexus has tried to record it in Bill.com. It contains:
   - invoice number (link to the invoice in Nexus);
   - amount charged;
   - customer name and number;
   - card used (e.g. "Visa •••• 4242");
   - who charged it and when (Hawaii time);
   - Bill.com: "Recorded in Bill.com", or a warning that recording failed and someone needs to check.
3. **Card-saved email:** goes to the Settings list instead of the fixed address.

## Non-goals

- Emails for failed or declined charges (the user chose successful only).
- Per-user notification preferences.

## Anti-goals

- A notification problem blocking or undoing a charge: email failures are logged, never shown as a charge failure.
- The card-saved email going silent when this ships: until the list is saved in Settings, it keeps going to the current address (CARD_SAVED_NOTIFY_EMAIL, otherwise fundraisers@hawaiicandyfactory.com). Once someone saves the list, the list wins, even if it is empty.
- More than one email for the same charge (a retry of the Bill.com step, or a "Check status" that finishes the charge, does not resend).

## Constraints

- **Storage:** a new migration 077 adds `org_notification_settings` (one row per organization: `backup_charge_emails text[]`, `card_saved_emails text[]` (null = never set), updated_at, updated_by). Readable by org members; written only by a server action that checks the user is an admin. The user applies the migration.
  - The existing `app_settings` table is not used: any signed-in user can write it and it has no organization column.
- **Sending:** Resend, with the same sender as the existing customer emails (CUSTOMER_EMAIL_FROM).
- **Before 077 is applied:** Settings shows a short "not available yet" note; charges work and send no charge email; the card-saved email uses the old address.
- Addresses are validated (simple email check) and de-duplicated, at most 20 per list.

## Approaches

- **A. Own table, admin-only writes (chosen):** safe and simple; needs one migration.
- **B. The existing `app_settings` table:** no migration, but any signed-in user could change who gets payment emails. Rejected.
- **C. Server environment variables only:** no Settings UI. Rejected: the user wants to manage it in the app.

## Send-once rule

- A `charge_email_sent_at` column on `card_payments` (in 077) is set when the email goes out.
- The email is sent by whichever path finishes the charge: the Charge button, Retry, or Check status. It is sent only if that column is still empty, and the column is claimed with a guarded update before sending.

## Left to the builder

- Exact layout of the Settings section (match the existing Settings cards).
- Email subject wording, e.g. "Backup payment charged: W-116080 · $314.14 · <customer> [NEXUS]".
