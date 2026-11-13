'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { OrderHeaderDefaults, ShipToRow } from '@/types/salesOrders';

export type ShipToChoice = { kind: 'saved'; code: string } | { kind: 'billing' } | { kind: 'oneoff' };

export type ShipToAddressFields = Pick<
  OrderHeaderDefaults,
  | 'ship_to_name' | 'ship_to_address' | 'ship_to_address_2' | 'ship_to_city' | 'ship_to_state'
  | 'ship_to_post_code' | 'ship_to_country' | 'ship_to_contact' | 'ship_to_phone'
>;

interface Props {
  rows: ShipToRow[];
  /** The customer's default ship-to code ('' = none). */
  defaultCode: string;
  choice: ShipToChoice;
  address: ShipToAddressFields;
  saveToCustomer: boolean;
  /** Saving a ship-to to the customer needs customer edit permission. */
  canSaveToCustomer: boolean;
  disabled: boolean;
  onChoose: (choice: ShipToChoice) => void;
  onAddressChange: (patch: Partial<ShipToAddressFields>) => void;
  onSaveToCustomerChange: (checked: boolean) => void;
}

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60';

const FIELDS: { key: keyof ShipToAddressFields; label: string; maxLength: number }[] = [
  { key: 'ship_to_name', label: 'Name', maxLength: 100 },
  { key: 'ship_to_address', label: 'Address', maxLength: 100 },
  { key: 'ship_to_address_2', label: 'Address 2', maxLength: 50 },
  { key: 'ship_to_city', label: 'City', maxLength: 30 },
  { key: 'ship_to_state', label: 'State', maxLength: 30 },
  { key: 'ship_to_post_code', label: 'ZIP', maxLength: 20 },
  { key: 'ship_to_country', label: 'Country', maxLength: 10 },
  { key: 'ship_to_contact', label: 'Contact', maxLength: 100 },
  { key: 'ship_to_phone', label: 'Phone', maxLength: 30 },
];

const valueOf = (c: ShipToChoice) => (c.kind === 'saved' ? `saved:${c.code}` : c.kind);
const choiceOf = (v: string): ShipToChoice =>
  v.startsWith('saved:') ? { kind: 'saved', code: v.slice('saved:'.length) } : v === 'oneoff' ? { kind: 'oneoff' } : { kind: 'billing' };

/** Ship-to dropdown: saved addresses (★ = default), the billing address, or a one-off typed in. */
export function ShipToPicker({
  rows,
  defaultCode,
  choice,
  address,
  saveToCustomer,
  canSaveToCustomer,
  disabled,
  onChoose,
  onAddressChange,
  onSaveToCustomerChange,
}: Props) {
  // An order can point at a code that is no longer in the list; keep it visible.
  const missing = choice.kind === 'saved' && !rows.some((r) => r.code === choice.code) ? choice.code : null;

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="so-ship-to" className="text-[11px] uppercase tracking-wide text-foreground-subtle">
          Ship to
        </Label>
        <select
          id="so-ship-to"
          className={SELECT_CLASS}
          value={valueOf(choice)}
          disabled={disabled}
          onChange={(e) => onChoose(choiceOf(e.target.value))}
        >
          {rows.map((r) => (
            <option key={r.code} value={`saved:${r.code}`}>
              {`${r.code === defaultCode ? '★ ' : ''}${r.code} – ${r.name}`}
            </option>
          ))}
          {missing && <option value={`saved:${missing}`}>{`${missing} – ${address.ship_to_name}`}</option>}
          <option value="billing">Billing address</option>
          <option value="oneoff">One-off address…</option>
        </select>
      </div>

      {choice.kind === 'oneoff' && (
        <div className="space-y-3 rounded-md border border-border p-3">
          <div className="grid gap-3 sm:grid-cols-3">
            {FIELDS.map((f) => (
              <div key={f.key} className="space-y-1.5">
                <Label htmlFor={`so-${f.key}`} className="text-[11px] uppercase tracking-wide text-foreground-subtle">
                  {f.label}
                </Label>
                <Input
                  id={`so-${f.key}`}
                  aria-label={`Ship-to ${f.label.toLowerCase()}`}
                  value={address[f.key]}
                  maxLength={f.maxLength}
                  disabled={disabled}
                  onChange={(e) => onAddressChange({ [f.key]: e.target.value })}
                />
              </div>
            ))}
          </div>
          {canSaveToCustomer && (
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={saveToCustomer}
                disabled={disabled}
                onChange={(e) => onSaveToCustomerChange(e.target.checked)}
              />
              Save to customer
            </label>
          )}
        </div>
      )}
    </div>
  );
}
