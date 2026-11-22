'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { getNotificationSettings, saveNotificationSettings } from '@/app/actions/notificationSettings';
import { EMAIL_PATTERN, MAX_NOTIFY_EMAILS } from '@/lib/notifications/settings';

type View = NonNullable<Awaited<ReturnType<typeof getNotificationSettings>>>;

/** One list's addresses plus what is typed in its box (not yet added). */
interface ListState {
  emails: string[];
  draft: string;
  error: string | null;
}

const listOf = (emails: string[]): ListState => ({ emails, draft: '', error: null });

/** Adds the typed address, if any. Returns null (with an error set) when it isn't valid. */
function withDraft(l: ListState): ListState | null {
  const e = l.draft.trim().toLowerCase();
  if (!e) return { ...l, draft: '', error: null };
  if (!EMAIL_PATTERN.test(e)) return null;
  if (l.emails.length >= MAX_NOTIFY_EMAILS && !l.emails.includes(e)) return null;
  return { emails: l.emails.includes(e) ? l.emails : [...l.emails, e], draft: '', error: null };
}

function draftError(l: ListState): string {
  return EMAIL_PATTERN.test(l.draft.trim().toLowerCase()) ? `At most ${MAX_NOTIFY_EMAILS} addresses.` : 'Enter a valid email address.';
}

function EmailList({
  title,
  hint,
  state,
  canEdit,
  onChange,
}: {
  title: string;
  hint: string;
  state: ListState;
  canEdit: boolean;
  onChange: (next: ListState) => void;
}) {
  const id = useId();
  const add = () => onChange(withDraft(state) ?? { ...state, error: draftError(state) });

  return (
    <div role="group" aria-labelledby={`${id}-title`} className="space-y-2">
      <div>
        <h3 id={`${id}-title`} className="text-sm font-medium text-foreground">
          {title}
        </h3>
        <p className="text-xs text-foreground-muted">{hint}</p>
      </div>
      {state.emails.length === 0 ? (
        <p className="text-sm text-foreground-muted">Nobody yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {state.emails.map((e) => (
            <li
              key={e}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-raised px-2.5 py-1 text-sm text-foreground"
            >
              <span>{e}</span>
              {canEdit && (
                <button
                  type="button"
                  aria-label={`Remove ${e}`}
                  onClick={() => onChange({ ...state, emails: state.emails.filter((x) => x !== e) })}
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
            value={state.draft}
            onChange={(e) => onChange({ ...state, draft: e.target.value, error: null })}
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
      {state.error && (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      )}
    </div>
  );
}

/** Settings > Receivables: who gets the backup payment emails. */
export function ReceivablesNotificationsCard() {
  const [view, setView] = useState<View | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [charged, setCharged] = useState<ListState>(listOf([]));
  const [saved, setSaved] = useState<ListState>(listOf([]));
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let live = true;
    getNotificationSettings()
      .then((v) => {
        if (!live) return;
        setView(v);
        if (v) {
          setCharged(listOf(v.backupChargeEmails));
          setSaved(listOf(v.cardSavedEmails));
        }
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Could not load the notification settings.'))
      .finally(() => live && setLoaded(true));
    return () => {
      live = false;
      clearTimeout(savedTimer.current);
    };
  }, []);

  if (!loaded || (!view && !error)) return null;

  const save = async () => {
    // An address typed but not added is saved too; an invalid one stops the save.
    const nextCharged = withDraft(charged);
    const nextSaved = withDraft(saved);
    if (!nextCharged) setCharged({ ...charged, error: draftError(charged) });
    if (!nextSaved) setSaved({ ...saved, error: draftError(saved) });
    if (!nextCharged || !nextSaved) return;
    setCharged(nextCharged);
    setSaved(nextSaved);

    setSaving(true);
    setError(null);
    setJustSaved(false);
    try {
      const next = await saveNotificationSettings({ backupChargeEmails: nextCharged.emails, cardSavedEmails: nextSaved.emails });
      setView(next);
      setCharged(listOf(next.backupChargeEmails));
      setSaved(listOf(next.cardSavedEmails));
      setJustSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setJustSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const edit = (set: (v: ListState) => void) => (v: ListState) => {
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
            {view.problem === 'not_applied'
              ? "Not available yet: the database update for notification emails hasn't been applied."
              : "Couldn't load the notification emails. Refresh the page to try again."}
          </p>
        ) : view ? (
          <>
            <EmailList
              title="Backup payment charged"
              hint="Emailed when a customer's backup card is charged successfully: invoice, amount, customer and card."
              state={charged}
              canEdit={view.canEdit}
              onChange={edit(setCharged)}
            />
            <EmailList
              title="Backup payment method saved"
              hint="Emailed when a customer saves a card on file."
              state={saved}
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
