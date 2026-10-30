'use client';

import { useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';

import { deleteReferenceEntry, syncReferenceList } from '@/app/actions/customerReferenceLists';
import { Button } from '@/components/ui/button';
import type { FieldSpec, ListPageData, ReferenceEntry } from '@/types/customerReferences';
import { ReferenceEntryForm } from './ReferenceEntryForm';

interface Props {
  data: ListPageData;
  selectOptions: Record<string, { code: string; label: string }[]>;
  /** Pre-filled into new entries (used by detail pages that scope a list to a parent). */
  fixedValues?: Record<string, unknown>;
  /** Fields kept in the data but hidden from the table and form. */
  hiddenFields?: string[];
  /** Extra content shown at the end of each row (e.g. links). */
  renderRowExtra?: (entry: ReferenceEntry) => ReactNode;
}

function cell(f: FieldSpec, v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (f.type === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

export function ReferenceListClient({ data, selectOptions, fixedValues, hiddenFields = [], renderRowExtra }: Props) {
  const router = useRouter();
  const [form, setForm] = useState<{ entry: ReferenceEntry | null } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const readOnly = data.mode === 'readOnly';
  const canEdit = data.canManage && !readOnly;
  const shownFields = data.fields.filter((f) => !hiddenFields.includes(f.name));
  const deleteBlocked = data.deleteDisabledReason !== null;

  function sync() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await syncReferenceList(data.key);
      if (res.ok) {
        setNotice(`Synced: ${res.inserted} added, ${res.updated} updated, ${res.deleted} removed`);
        router.refresh();
      } else setError(res.error);
    });
  }

  function remove(id: string) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await deleteReferenceEntry(data.key, id);
      if (res.ok) {
        setConfirmId(null);
        router.refresh();
      } else setError(res.error);
    });
  }

  function saved(warning?: string) {
    setForm(null);
    setError(null);
    setNotice(warning ?? null);
    router.refresh();
  }

  return (
    <div className="space-y-4 p-5">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{data.title}</h1>
          {readOnly && (
            <p className="mt-1 text-xs text-foreground-subtle">Managed in Business Central — copied here to pick from.</p>
          )}
        </div>
        {data.canManage && (
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={sync}>
            <RefreshCw className="size-4" />
            Sync with BC
          </Button>
        )}
        {canEdit && (
          <Button type="button" size="sm" onClick={() => setForm({ entry: null })}>
            <Plus className="size-4" />
            Add
          </Button>
        )}
      </header>

      {error && (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground">
          {notice}
        </div>
      )}

      {form && (
        <ReferenceEntryForm
          key={form.entry?.id ?? 'new'}
          listKey={data.key}
          fields={data.fields}
          entry={form.entry}
          selectOptions={selectOptions}
          fixedValues={fixedValues}
          hiddenFields={hiddenFields}
          onDone={saved}
          onCancel={() => setForm(null)}
        />
      )}

      <div className="overflow-x-auto rounded-xl border border-border bg-surface-raised card-shadow">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-foreground-subtle">
              {shownFields.map((f) => (
                <th key={f.name} className="px-3 py-2 font-medium">{f.label}</th>
              ))}
              {renderRowExtra && <th className="px-3 py-2" />}
              {canEdit && <th className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {data.entries.length === 0 && (
              <tr>
                <td colSpan={shownFields.length + 2} className="px-3 py-8 text-center text-foreground-muted">
                  No entries yet.
                </td>
              </tr>
            )}
            {data.entries.map((entry) => (
              <tr key={entry.id} className="border-b border-border last:border-0">
                {shownFields.map((f) => {
                  const text = cell(f, entry.values[f.name]);
                  return (
                    <td key={f.name} className="px-3 py-2 text-foreground">
                      {data.key === 'taxAreas' && f.name === 'code' && text ? (
                        <Link className="text-primary hover:underline" href={`/customer-lists/tax-areas/${encodeURIComponent(text)}`}>
                          {text}
                        </Link>
                      ) : (
                        text
                      )}
                    </td>
                  );
                })}
                {renderRowExtra && <td className="px-3 py-2">{renderRowExtra(entry)}</td>}
                {canEdit && (
                  <td className="px-3 py-2">
                    {confirmId === entry.id ? (
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <span className="text-xs text-foreground-muted">Delete this entry?</span>
                        <Button type="button" size="sm" variant="destructive" disabled={pending} onClick={() => remove(entry.id)}>
                          Confirm delete
                        </Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => setConfirmId(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button type="button" size="sm" variant="outline" onClick={() => setForm({ entry })}>
                          <Pencil className="size-4" />
                          Edit
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={deleteBlocked}
                          title={data.deleteDisabledReason ?? undefined}
                          onClick={() => {
                            setError(null);
                            setConfirmId(entry.id);
                          }}
                        >
                          <Trash2 className="size-4" />
                          Delete
                        </Button>
                        {deleteBlocked && <span className="text-xs text-foreground-muted">{data.deleteDisabledReason}</span>}
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
