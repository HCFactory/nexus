'use client';

import { useState, useTransition } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { addSalesOrderNote, deleteSalesOrderNote, updateSalesOrderNote } from '@/app/actions/salesOrderNotes';
import { GlassButton as Button } from './GlassButton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { NoteView } from '@/types/salesOrders';

type Saved = { ok: true; note: NoteView } | { ok: false; error: string };

/** Where notes are saved: sales order notes by default, invoice notes for invoices. */
export interface NotesActions {
  add(parentId: string, body: string): Promise<Saved>;
  update(noteId: string, body: string): Promise<Saved>;
  remove(noteId: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

const ORDER_ACTIONS: NotesActions = {
  add: addSalesOrderNote,
  update: updateSalesOrderNote,
  remove: deleteSalesOrderNote,
};

interface Props {
  /** The order (or invoice) the notes belong to; null = it isn't saved yet. */
  parentId: string | null;
  canEdit: boolean;
  initialNotes: NoteView[];
  /** Defaults to sales order notes. */
  actions?: NotesActions;
  /** Shown while there is nothing to attach notes to. */
  unsavedHint?: string;
}

const TEXTAREA_CLASS =
  'w-full rounded-md border border-input bg-field px-3 py-2 text-sm text-foreground shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60';

/** Cmd+Enter (Mac) or Ctrl+Enter (Windows) runs `run`. */
const onSubmitKey = (run: () => void) => (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    run();
  }
};

/** Plain icon buttons (no glass): blue on hover for edit, red for delete. */
const ICON_BUTTON =
  'inline-flex size-6 items-center justify-center rounded-md text-foreground-muted transition-colors disabled:opacity-50';
const EDIT_HOVER = 'hover:bg-primary/15 hover:text-primary';
const DELETE_HOVER = 'hover:bg-destructive/15 hover:text-destructive';

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

/** Timestamped note cards. Notes save immediately, apart from the order form's Save button. */
export function NotesPanel({ parentId, canEdit, initialNotes, actions = ORDER_ACTIONS, unsavedHint = 'Save the order to add notes.' }: Props) {
  const [notes, setNotes] = useState(initialNotes);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [deleting, setDeleting] = useState<NoteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  if (parentId === null) {
    return <p className="text-sm text-foreground-muted">{unsavedHint}</p>;
  }

  const add = () => {
    if (busy || draft.trim() === '') return;
    setError(null);
    startTransition(async () => {
      const res = await actions.add(parentId, draft);
      if (!res.ok) return setError(res.error);
      setNotes((list) => [res.note, ...list]);
      setDraft('');
    });
  };

  const save = (id: string) => {
    if (busy || editText.trim() === '') return;
    setError(null);
    startTransition(async () => {
      const res = await actions.update(id, editText);
      if (!res.ok) return setError(res.error);
      setNotes((list) => list.map((n) => (n.id === id ? res.note : n)));
      setEditingId(null);
    });
  };

  const remove = (id: string) => {
    setError(null);
    startTransition(async () => {
      const res = await actions.remove(id);
      setDeleting(null);
      if (!res.ok) return setError(res.error);
      setNotes((list) => list.filter((n) => n.id !== id));
    });
  };

  return (
    <div className="space-y-3">
      {error && (
        <div role="alert" className="rounded-md bg-destructive-subtle px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {canEdit && (
        <div className="relative">
          <textarea
            aria-label="New note"
            rows={3}
            value={draft}
            disabled={busy}
            placeholder="Add a note…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onSubmitKey(add)}
            className={`${TEXTAREA_CLASS} block resize-none pr-11`}
          />
          <Button
            type="button"
            size="icon-sm"
            aria-label="Add note"
            title="Add note (⌘/Ctrl + Enter)"
            disabled={busy || draft.trim() === ''}
            onClick={add}
            className="absolute! bottom-2 right-2"
          >
            <Plus className="size-4" />
          </Button>
        </div>
      )}

      {notes.length > 0 && (
        <ul className="max-h-80 space-y-2 overflow-y-auto pr-1">
          {notes.map((n) => (
            <li key={n.id} className="rounded-md border border-border bg-background px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs leading-6 text-foreground-muted">
                  {n.author_name ? `${n.author_name} · ` : ''}
                  {when(n.created_at)}
                  {n.updated_at > n.created_at && <> <span>(edited)</span></>}
                </p>
                {canEdit && editingId !== n.id && (
                  <div className="-mr-1 flex">
                    <button
                      type="button"
                      className={`${ICON_BUTTON} ${EDIT_HOVER}`}
                      aria-label="Edit note"
                      disabled={busy}
                      onClick={() => { setEditingId(n.id); setEditText(n.body); setError(null); }}
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      className={`${ICON_BUTTON} ${DELETE_HOVER}`}
                      aria-label="Delete note"
                      disabled={busy}
                      onClick={() => setDeleting(n)}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                )}
              </div>
              {editingId === n.id ? (
                <div className="mt-2 space-y-2">
                  <textarea
                    aria-label="Edit note text"
                    rows={3}
                    value={editText}
                    disabled={busy}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={onSubmitKey(() => save(n.id))}
                    className={TEXTAREA_CLASS}
                  />
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                    <Button type="button" size="sm" disabled={busy || editText.trim() === ''} onClick={() => save(n.id)}>
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="whitespace-pre-wrap text-sm leading-snug text-foreground">{n.body}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      <Dialog open={deleting !== null} onOpenChange={(o) => { if (!o && !busy) setDeleting(null); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete this note?</DialogTitle>
            <DialogDescription>This can&apos;t be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" disabled={busy} onClick={() => deleting && remove(deleting.id)}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
