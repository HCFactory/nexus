'use client';

import { useState, useTransition } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { addSalesOrderNote, deleteSalesOrderNote, updateSalesOrderNote } from '@/app/actions/salesOrderNotes';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { SalesOrderNoteView } from '@/types/salesOrders';

interface Props {
  /** null = the order isn't saved yet. */
  orderId: string | null;
  canEdit: boolean;
  initialNotes: SalesOrderNoteView[];
}

const TEXTAREA_CLASS =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60';

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

/** Timestamped note cards. Notes save immediately, apart from the order form's Save button. */
export function NotesPanel({ orderId, canEdit, initialNotes }: Props) {
  const [notes, setNotes] = useState(initialNotes);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [deleting, setDeleting] = useState<SalesOrderNoteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  if (orderId === null) {
    return <p className="text-sm text-foreground-muted">Save the order to add notes.</p>;
  }

  const add = () => {
    setError(null);
    startTransition(async () => {
      const res = await addSalesOrderNote(orderId, draft);
      if (!res.ok) return setError(res.error);
      setNotes((list) => [res.note, ...list]);
      setDraft('');
    });
  };

  const save = (id: string) => {
    setError(null);
    startTransition(async () => {
      const res = await updateSalesOrderNote(id, editText);
      if (!res.ok) return setError(res.error);
      setNotes((list) => list.map((n) => (n.id === id ? res.note : n)));
      setEditingId(null);
    });
  };

  const remove = (id: string) => {
    setError(null);
    startTransition(async () => {
      const res = await deleteSalesOrderNote(id);
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
        <div className="space-y-2">
          <textarea
            aria-label="New note"
            rows={3}
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            className={TEXTAREA_CLASS}
          />
          <div className="flex justify-end">
            <Button type="button" size="sm" disabled={busy || draft.trim() === ''} onClick={add}>
              Add
            </Button>
          </div>
        </div>
      )}

      {notes.length > 0 && (
        <ul className="space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-md border border-border bg-background p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs text-foreground-muted">
                  {n.author_name ? `${n.author_name} · ` : ''}
                  {when(n.created_at)}
                  {n.updated_at > n.created_at && <> <span>(edited)</span></>}
                </p>
                {canEdit && editingId !== n.id && (
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Edit note"
                      disabled={busy}
                      onClick={() => { setEditingId(n.id); setEditText(n.body); setError(null); }}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Delete note"
                      disabled={busy}
                      onClick={() => setDeleting(n)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
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
                <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{n.body}</p>
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
