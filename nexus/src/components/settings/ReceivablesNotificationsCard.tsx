'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import { getNotificationSettings, saveNotificationSettings } from '@/app/actions/notificationSettings';

type View = NonNullable<Awaited<ReturnType<typeof getNotificationSettings>>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX = 20;

function EmailList({
  title,
  hint,
  emails,
  canEdit,
  onChange,
}: {
  title: string;
  hint: string;
  emails: string[];
  canEdit: boolean;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  const add = () => {
    const e = draft.trim().toLowerCase();
    if (!e) return;
    if (!EMAIL.test(e)) return setError('Enter a valid email address.');
    if (emails.length >= MAX && !emails.includes(e)) return setError(`At most ${MAX} addresses.`);
    if (!emails.includes(e)) onChange([...emails, e]);
    setDraft('');
    setError(null);
  };

  return (
    <div role="group" aria-labelledby={`${id}-title`} className="space-y-2">
      <div>
        <h3 id={`${id}-title`} className="text-sm font-medium text-foreground">
          {title}
        </h3>
        <p className="text-xs text-foreground-muted">{hint}</p>
      </div>
      {emails.length === 0 ? (
        <p className="text-sm text-foreground-muted">Nobody yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {emails.map((e) => (
            <li
              key={e}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-raised px-2.5 py-1 text-sm text-foreground"
            >
              <span>{e}</span>
              {canEdit && (
                <button
                  type="button"
                  aria-label={`Remove ${e}`}
                  onClick={() => onChange(emails.filter((x) => x !== e))}
                  className="rounded-full p-0.5 text-foreground-muted hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="flex max-w-md gap-2">
          <input
            type="text"
            inputMode="email"
            aria-label={`Add an email for ${title}`}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            placeholder="name@example.com"
            className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <button
            type="button"
            onClick={add}
            className="rounded-md border border-border px-3 py-2 text-sm text-foreground hover:bg-surface-raised"
          >
            Add
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Settings > Receivables: who gets the backup payment emails. */
export function ReceivablesNotificationsCard() {
  const [view, setView] = useState<View | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [charged, setCharged] = useState<string[]>([]);
  const [saved, setSaved] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getNotificationSettings()
      .then((v) => {
        if (!live) return;
        setView(v);
        if (v) {
          setCharged(v.backupChargeEmails);
          setSaved(v.cardSavedEmails);
        }
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Could not load the notification settings.'))
      .finally(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, []);

  if (!loaded || (!view && !error)) return null;

  const save = async () => {
    setSaving(true);
    setError(null);
    setJustSaved(false);
    try {
      const next = await saveNotificationSettings({ backupChargeEmails: charged, cardSavedEmails: saved });
      setView(next);
      setCharged(next.backupChargeEmails);
      setSaved(next.cardSavedEmails);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setJustSaved(false);
  };

  return (
    <div className="mt-6 rounded-lg border border-border bg-surface shadow-sm">
      <div className="border-b border-border px-6 py-4">
        <h2 className="text-lg font-semibold text-foreground">Receivables</h2>
        <p className="mt-0.5 text-sm text-foreground-muted">Backup payment notifications</p>
      </div>
      <div className="space-y-6 px-6 py-5">
        {view && !view.available ? (
          <p className="text-sm text-foreground-muted">
            Not available yet: the database update for notification emails hasn&apos;t been applied.
          </p>
        ) : view ? (
          <>
            <EmailList
              title="Backup payment charged"
              hint="Emailed when a customer's backup card is charged successfully: invoice, amount, customer and card."
              emails={charged}
              canEdit={view.canEdit}
              onChange={edit(setCharged)}
            />
            <EmailList
              title="Backup payment method saved"
              hint="Emailed when a customer saves a card on file."
              emails={saved}
              canEdit={view.canEdit}
              onChange={edit(setSaved)}
            />
            {view.canEdit ? (
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-50"
              >
                {saving ? 'Saving...' : justSaved ? 'Saved' : 'Save'}
              </button>
            ) : (
              <p className="text-xs text-foreground-muted">Only admins can change these.</p>
            )}
          </>
        ) : null}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}
