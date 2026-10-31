'use client';

import { Button } from '@/components/ui/button';
import { coerce } from '@/lib/businessCentral/customerReferences/mapping';
import { changedFields } from '@/lib/businessCentral/customerReferences/merge';
import type { FieldSpec } from '@/types/customerReferences';

interface ChangePreviewProps {
  fields: FieldSpec[];
  original: Record<string, unknown> | null;
  edited: Record<string, unknown>;
  onConfirm(): void;
  onCancel(): void;
  disabled?: boolean;
}

/** Values as Business Central will store them: the same null coercion as toBcFields. */
function asBc(fields: FieldSpec[], values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(fields.map((f) => [f.name, coerce(f, values[f.name])]));
}

function show(value: unknown, field: FieldSpec): string {
  if (value === null || value === undefined || value === '') return '(empty)';
  if (field.type === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

export function ChangePreview({ fields, original, edited, onConfirm, onCancel, disabled }: ChangePreviewProps) {
  const editable = fields.filter((f) => f.editable);
  const before = original ? asBc(editable, original) : null;
  const after = asBc(editable, edited);
  // A create sends every editable field, so list them all.
  const names = before ? changedFields(before, after, editable) : editable.map((f) => f.name);
  const shown = editable.filter((f) => names.includes(f.name));

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold text-foreground">These changes will be saved to Business Central</h3>
      {shown.length === 0 ? (
        <p className="text-sm text-foreground-muted">Nothing has changed.</p>
      ) : (
        <ul className="space-y-1 text-sm text-foreground">
          {shown.map((f) => (
            <li key={f.name}>
              {before
                ? `${f.label}: ${show(before[f.name], f)} → ${show(after[f.name], f)}`
                : `${f.label}: ${show(after[f.name], f)}`}
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={disabled || shown.length === 0} onClick={onConfirm}>
          {disabled ? 'Saving…' : 'Confirm and save'}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onCancel}>
          Back
        </Button>
      </div>
    </div>
  );
}
