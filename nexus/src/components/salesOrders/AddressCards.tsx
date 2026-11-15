'use client';

import { useState, type ComponentProps, type ReactNode } from 'react';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { OrderHeaderDefaults } from '@/types/salesOrders';
import { ShipToPicker } from './ShipToPicker';

export type BillingValues = Pick<
  OrderHeaderDefaults,
  | 'bill_name' | 'bill_address' | 'bill_address_2' | 'bill_city' | 'bill_state' | 'bill_post_code' | 'bill_country'
  | 'bill_contact_no' | 'bill_phone' | 'bill_mobile' | 'bill_email' | 'bill_email_cc'
>;

const LABEL = 'text-[11px] uppercase tracking-wide text-foreground-subtle';
const INPUT_CLASS = 'border-input bg-background dark:bg-background';

const BILLING_FIELDS: { key: keyof BillingValues; label: string; maxLength: number; type?: string }[] = [
  { key: 'bill_address', label: 'Address', maxLength: 100 },
  { key: 'bill_address_2', label: 'Address 2', maxLength: 50 },
  { key: 'bill_city', label: 'City', maxLength: 30 },
  { key: 'bill_state', label: 'State', maxLength: 30 },
  { key: 'bill_post_code', label: 'ZIP code', maxLength: 20 },
  { key: 'bill_country', label: 'Country/Region', maxLength: 10 },
  { key: 'bill_contact_no', label: 'Contact no.', maxLength: 20 },
  { key: 'bill_phone', label: 'Phone no.', maxLength: 30, type: 'tel' },
  { key: 'bill_mobile', label: 'Mobile phone no.', maxLength: 30, type: 'tel' },
  { key: 'bill_email', label: 'Email', maxLength: 80, type: 'email' },
  { key: 'bill_email_cc', label: 'Email CC', maxLength: 80 },
];

const clean = (s: unknown) => String(s ?? '').trim();
const cityLine = (city: string, state: string, zip: string) =>
  [[city, state].filter(Boolean).join(', '), zip].filter(Boolean).join(' ');

function Card({ title, editing, canEdit, editLabel, onToggle, children }: {
  title: string; editing: boolean; canEdit: boolean; editLabel: string; onToggle: () => void; children: ReactNode;
}) {
  return (
    <section className="glass-card rounded-xl p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {canEdit &&
          (editing ? (
            <Button type="button" size="sm" variant="outline" onClick={onToggle}>Done</Button>
          ) : (
            <button
              type="button"
              aria-label={editLabel}
              className="rounded-md p-1.5 text-foreground-subtle hover:bg-surface-sunken hover:text-foreground"
              onClick={onToggle}
            >
              <Pencil className="size-4" />
            </button>
          ))}
      </div>
      {children}
    </section>
  );
}

function TextLines({ lines, muted }: { lines: string[]; muted?: string }) {
  return (
    <div className="space-y-0.5 text-sm text-foreground">
      {lines.length === 0 && <p className="text-foreground-subtle">—</p>}
      {lines.map((l, i) => <p key={i}>{l}</p>)}
      {muted && <p className="text-xs text-foreground-subtle">{muted}</p>}
    </div>
  );
}

export function BillingCard({ values, editable, onChange }: {
  values: BillingValues;
  editable: boolean;
  onChange: (patch: Partial<BillingValues>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const open = editing && editable;
  const lines = [
    clean(values.bill_name),
    clean(values.bill_address),
    clean(values.bill_address_2),
    cityLine(clean(values.bill_city), clean(values.bill_state), clean(values.bill_post_code)),
    clean(values.bill_country),
    clean(values.bill_phone),
    clean(values.bill_email),
  ].filter(Boolean);

  return (
    <Card title="Billing address" editing={open} canEdit={editable} editLabel="Edit billing address" onToggle={() => setEditing(!open)}>
      {open ? (
        <fieldset className="min-w-0">
          <legend className="sr-only">Billing address</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {BILLING_FIELDS.map((f) => (
              <div key={f.key} className={`space-y-1.5 ${f.key === 'bill_address' || f.key === 'bill_address_2' ? 'sm:col-span-2' : ''}`}>
                <Label htmlFor={`so-${f.key}`} className={LABEL}>{f.label}</Label>
                <Input
                  id={`so-${f.key}`}
                  className={INPUT_CLASS}
                  type={f.type ?? 'text'}
                  value={String(values[f.key] ?? '')}
                  maxLength={f.maxLength}
                  onChange={(e) => onChange({ [f.key]: e.target.value })}
                />
              </div>
            ))}
          </div>
        </fieldset>
      ) : (
        <TextLines lines={lines} />
      )}
    </Card>
  );
}

export function ShipToCard({ editable, ...picker }: ComponentProps<typeof ShipToPicker> & { editable: boolean }) {
  const [editing, setEditing] = useState(false);
  const open = editing && editable;
  const a = picker.address;
  const lines = [
    clean(a.ship_to_name),
    clean(a.ship_to_address),
    clean(a.ship_to_address_2),
    cityLine(clean(a.ship_to_city), clean(a.ship_to_state), clean(a.ship_to_post_code)),
  ].filter(Boolean);
  const code = picker.choice.kind === 'saved' ? picker.choice.code : '';

  return (
    <Card title="Ship to" editing={open} canEdit={editable} editLabel="Edit ship-to" onToggle={() => setEditing(!open)}>
      {open ? <ShipToPicker {...picker} disabled={!editable} /> : <TextLines lines={lines} muted={code || undefined} />}
    </Card>
  );
}
