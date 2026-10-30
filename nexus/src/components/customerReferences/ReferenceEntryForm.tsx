'use client';

import { useState, useTransition } from 'react';

import { saveReferenceEntry } from '@/app/actions/customerReferenceLists';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { validateEntry } from '@/lib/businessCentral/customerReferences/validation';
import type { FieldSpec, ListKey, ReferenceEntry } from '@/types/customerReferences';
import { ChangePreview } from './ChangePreview';

type Option = { code: string; label: string };
type Row = Record<string, unknown>;

interface Props {
  listKey: ListKey;
  fields: FieldSpec[];
  entry: ReferenceEntry | null;
  selectOptions: Record<string, Option[]>;
  onDone(warning?: string): void;
  onCancel(): void;
}

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50';

function toRaw(f: FieldSpec, v: unknown): string | boolean {
  if (f.type === 'boolean') return Boolean(v);
  return v === null || v === undefined ? '' : String(v);
}

function toValue(f: FieldSpec, raw: string | boolean): unknown {
  if (f.type === 'boolean') return Boolean(raw);
  if (typeof raw === 'string' && raw.trim() === '') return null;
  if (f.type === 'percent' || f.type === 'number') return Number(raw);
  return raw;
}

export function ReferenceEntryForm({ listKey, fields, entry, selectOptions, onDone, onCancel }: Props) {
  const editable = fields.filter((f) => f.editable);
  const keyFields = fields.filter((f) => f.isKey);
  const renamable = keyFields.length === 1 && keyFields[0].name === 'code';
  const [raw, setRaw] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(editable.map((f) => [f.name, toRaw(f, entry?.values[f.name])])),
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);
  const [edited, setEdited] = useState<Row | null>(null);
  const [pending, startTransition] = useTransition();

  const isDisabled = (f: FieldSpec) => entry !== null && f.isKey === true && !renamable;

  function review() {
    const values: Row = {};
    for (const f of editable) values[f.name] = toValue(f, raw[f.name]);
    const problems = validateEntry(editable, values);
    setErrors(problems);
    setServerError(null);
    if (problems.length === 0) setEdited(values);
  }

  function confirm() {
    if (!edited) return;
    startTransition(async () => {
      const res = await saveReferenceEntry(listKey, {
        id: entry?.id ?? null,
        original: entry ? entry.values : null,
        edited,
      });
      if (res.ok) onDone(res.warning);
      else setServerError(res.error);
    });
  }

  if (edited) {
    return (
      <div className="space-y-3">
        {serverError && (
          <div role="alert" className="rounded-md border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive">
            {serverError}
          </div>
        )}
        <ChangePreview
          fields={fields}
          original={entry ? entry.values : null}
          edited={edited}
          disabled={pending}
          onConfirm={confirm}
          onCancel={() => setEdited(null)}
        />
      </div>
    );
  }

  return (
    <form
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        review();
      }}
    >
      <h3 className="text-sm font-semibold text-foreground">{entry ? 'Edit entry' : 'Add entry'}</h3>
      {errors.length > 0 && (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive">
          <ul className="list-disc pl-4">
            {errors.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {editable.map((f) => {
          const id = `ref-${f.name}`;
          const value = raw[f.name];
          const set = (v: string | boolean) => setRaw((cur) => ({ ...cur, [f.name]: v }));
          return (
            <div key={f.name} className="min-w-0 space-y-1.5">
              {f.type === 'boolean' ? (
                <label htmlFor={id} className="flex items-center gap-2 text-sm text-foreground">
                  <input id={id} type="checkbox" checked={Boolean(value)} disabled={isDisabled(f)} onChange={(e) => set(e.target.checked)} />
                  {f.label}
                </label>
              ) : (
                <>
                  <Label htmlFor={id} className="text-[11px] uppercase tracking-wide text-foreground-subtle">
                    {f.label}
                    {f.required ? ' *' : ''}
                  </Label>
                  {f.type === 'select' ? (
                    <select id={id} className={SELECT_CLASS} value={String(value)} disabled={isDisabled(f)} onChange={(e) => set(e.target.value)}>
                      {!f.required && <option value="" />}
                      {(f.optionsFrom ? selectOptions[f.optionsFrom] ?? [] : []).map((o) => (
                        <option key={o.code} value={o.code}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      id={id}
                      type={f.type === 'date' ? 'date' : f.type === 'percent' || f.type === 'number' ? 'number' : 'text'}
                      step={f.type === 'percent' || f.type === 'number' ? 'any' : undefined}
                      value={String(value)}
                      disabled={isDisabled(f)}
                      onChange={(e) => set(e.target.value)}
                    />
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm">
          Review changes
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
