'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Plus, Trash2 } from 'lucide-react';

import { deleteShipToAction, setDefaultShipToAction } from '@/app/actions/shipToAddresses';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { ShipToRow } from '@/types/salesOrders';
import { ShipToDialog, type ShipToOptions } from './ShipToDialog';

interface Props {
  customerNumber: string;
  /** The customer's default ship-to code ('' = none). */
  defaultCode: string;
  rows: ShipToRow[];
  canEdit: boolean;
  options: ShipToOptions;
}

export function ShipToSection({ customerNumber, defaultCode, rows, canEdit, options }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState<ShipToRow | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ShipToRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const makeDefault = (code: string) => {
    setError(null);
    startTransition(async () => {
      const res = await setDefaultShipToAction(customerNumber, code);
      if (!res.ok) setError(res.error);
      else router.refresh();
    });
  };

  const confirmDelete = () => {
    const row = deleting;
    if (!row) return;
    setError(null);
    startTransition(async () => {
      const res = await deleteShipToAction(row.id);
      setDeleting(null);
      if (!res.ok) setError(res.error);
      else router.refresh();
    });
  };

  return (
    <div className="rounded-xl border border-border bg-surface-raised card-shadow">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">Ship-to addresses</h3>
        {canEdit && (
          <Button type="button" size="sm" variant="outline" onClick={() => setEditing('new')}>
            <Plus className="size-4" />
            Add
          </Button>
        )}
      </div>
      {error && (
        <div role="alert" className="border-b border-border bg-destructive-subtle px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-foreground-muted">No ship-to addresses yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-foreground-subtle">
              <tr>
                <th className="w-10 px-4 py-2.5 font-medium"><span className="sr-only">Default</span></th>
                <th className="px-4 py-2.5 font-medium">Code</th>
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">City / State</th>
                {canEdit && <th className="px-4 py-2.5"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => {
                const isDefault = row.code === defaultCode;
                return (
                  <tr key={row.id}>
                    <td className="px-4 py-2.5">
                      {isDefault ? (
                        <span aria-label="Default ship-to" className="text-warning">★</span>
                      ) : canEdit ? (
                        <button
                          type="button"
                          aria-label={`Make ${row.code} the default`}
                          disabled={pending}
                          className="text-foreground-subtle hover:text-foreground"
                          onClick={() => makeDefault(row.code)}
                        >
                          ☆
                        </button>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-foreground-muted">{row.code}</td>
                    <td className="px-4 py-2.5 text-foreground">{row.name}</td>
                    <td className="px-4 py-2.5 text-foreground-muted">
                      {[row.city, row.state].filter(Boolean).join(', ') || '—'}
                    </td>
                    {canEdit && (
                      <td className="px-4 py-2.5 text-right">
                        <Button type="button" size="icon-sm" variant="ghost" aria-label={`Edit ${row.code}`} onClick={() => setEditing(row)}>
                          <Pencil className="size-4" />
                        </Button>
                        <Button type="button" size="icon-sm" variant="ghost" aria-label={`Delete ${row.code}`} onClick={() => setDeleting(row)}>
                          <Trash2 className="size-4" />
                        </Button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <ShipToDialog
          key={editing === 'new' ? 'new' : editing.id}
          customerNumber={customerNumber}
          row={editing === 'new' ? null : editing}
          options={options}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}

      <Dialog open={deleting !== null} onOpenChange={(o) => { if (!o) setDeleting(null); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete ship-to address?</DialogTitle>
            <DialogDescription>
              Delete ship-to {deleting?.code}. It will also be removed from Business Central.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" size="sm" variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button type="button" size="sm" variant="destructive" disabled={pending} onClick={confirmDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
