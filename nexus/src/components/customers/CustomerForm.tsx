'use client';

import { useState, useTransition } from 'react';

import { createCustomerAction, updateCustomerAction, type CustomerTemplateOption } from '@/app/actions/customerEditing';
import { FieldInput, optionsFor, toRaw, toValue } from '@/components/customerReferences/ReferenceEntryForm';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { normalizeBlocked } from '@/lib/businessCentral/customerMapper';
import { changedFields } from '@/lib/businessCentral/customerReferences/merge';
import { validateEntry } from '@/lib/businessCentral/customerReferences/validation';
import { CUSTOMER_FIELDS } from '@/lib/businessCentral/customers/customerFields';
import type { FieldSpec } from '@/types/customerReferences';

type Option = { code: string; label: string };
type Row = Record<string, unknown>;

interface Props {
  /** null = create a new customer. */
  customer: { id: string; values: Row } | null;
  templates: CustomerTemplateOption[];
  selectOptions: Record<string, Option[]>;
  onDone(result: { id: string; warning?: string }): void;
  onCancel(): void;
}

/** Fields typed on create; the rest come from the template. Blocked and Credit limit are edit-only. */
const CREATE_FIELD_NAMES = [
  'display_name', 'email', 'email_cc', 'phone_number',
  'address_line_1', 'address_line_2', 'city', 'state', 'postal_code', 'country',
  'payment_terms_code', 'tax_area_code',
];
const CREATE_FIELDS: FieldSpec[] = CUSTOMER_FIELDS.filter((f) => CREATE_FIELD_NAMES.includes(f.name));

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

export function CustomerForm({ customer, templates, selectOptions, onDone, onCancel }: Props) {
  const fields = customer ? CUSTOMER_FIELDS : CREATE_FIELDS;
  const [templateCode, setTemplateCode] = useState('');
  const [raw, setRaw] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      fields.map((f) => {
        const v = customer ? customer.values[f.name] : null;
        // Stored null means "not blocked"; the select's option for that is ' '.
        return [f.name, f.name === 'blocked' && !normalizeBlocked(v) ? ' ' : toRaw(f, v)];
      }),
    ),
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  function chooseTemplate(code: string) {
    setTemplateCode(code);
    const template = templates.find((t) => t.code === code);
    if (!template) return;
    setRaw((cur) => ({
      ...cur,
      payment_terms_code: toRaw(CREATE_FIELDS.find((f) => f.name === 'payment_terms_code')!, template.values.payment_terms_code),
      tax_area_code: toRaw(CREATE_FIELDS.find((f) => f.name === 'tax_area_code')!, template.values.tax_area_code),
    }));
  }

  function submit() {
    const values: Row = {};
    for (const f of fields) values[f.name] = toValue(f, raw[f.name]);
    // Creates validate every field; edits only what changed.
    const toCheck = customer ? fields.filter((f) => changedFields(customer.values, values, fields).includes(f.name)) : fields;
    const problems = [
      ...(!customer && !templateCode ? ['Choose a customer template'] : []),
      ...validateEntry(toCheck, values),
    ];
    setErrors(problems);
    if (problems.length > 0) return;

    startTransition(async () => {
      if (customer) {
        const res = await updateCustomerAction({ id: customer.id, original: customer.values, edited: values });
        if (res.ok) onDone({ id: customer.id });
        else setErrors([res.error]);
      } else {
        const res = await createCustomerAction({ templateCode, values });
        if (res.ok) onDone(res.warning ? { id: res.id, warning: res.warning } : { id: res.id });
        else setErrors([res.error]);
      }
    });
  }

  return (
    <form
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h3 className="text-sm font-semibold text-foreground">{customer ? 'Edit customer' : 'New customer'}</h3>
      {errors.length > 0 && (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive">
          <ul className="list-disc pl-4">
            {errors.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      {!customer && (
        <div className="space-y-1.5">
          <Label htmlFor="customer-template" className="text-[11px] uppercase tracking-wide text-foreground-subtle">
            Customer template *
          </Label>
          <select id="customer-template" className={SELECT_CLASS} value={templateCode} onChange={(e) => chooseTemplate(e.target.value)}>
            <option value="" disabled>Select…</option>
            {templates.map((t) => (
              <option key={t.code} value={t.code}>
                {t.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-foreground-muted">The template fills in posting groups, tax and other settings.</p>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((f) => (
          <FieldInput
            key={f.name}
            idPrefix="customer"
            field={f}
            value={raw[f.name]}
            options={optionsFor(f, selectOptions)}
            disabled={pending}
            onChange={(v) => setRaw((cur) => ({ ...cur, [f.name]: v }))}
          />
        ))}
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : customer ? 'Save changes' : 'Create customer'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The CUSTOMER_FIELDS values of a customer row, as the edit form's `original`. */
export function customerFormValues(row: object): Row {
  const r = row as Row;
  return Object.fromEntries(CUSTOMER_FIELDS.map((f) => [f.name, r[f.name] ?? null]));
}
