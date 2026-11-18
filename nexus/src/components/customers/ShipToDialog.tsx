'use client';

import { useState, useTransition } from 'react';

import { saveShipToAction } from '@/app/actions/shipToAddresses';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { ShipToRow, ShipToValues } from '@/types/salesOrders';

type Option = { code: string; label: string };

export interface ShipToOptions {
  taxAreas: Option[];
  locations: Option[];
  shipmentMethods: Option[];
}

interface Props {
  customerNumber: string;
  /** null = add a new ship-to. */
  row: ShipToRow | null;
  options: ShipToOptions;
  onClose(): void;
  onSaved(): void;
}

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

const EMPTY: ShipToValues = {
  code: '', name: '', address: '', address_2: '', city: '', state: '', post_code: '', country: '',
  contact: '', phone: '', email: '', tax_area_code: '', location_code: '', shipment_method_code: '', tax_liable: false,
};

const pickValues = (row: ShipToValues): ShipToValues =>
  Object.fromEntries(Object.keys(EMPTY).map((k) => [k, row[k as keyof ShipToValues] ?? EMPTY[k as keyof ShipToValues]])) as unknown as ShipToValues;

type TextKey = Exclude<keyof ShipToValues, 'tax_liable' | 'tax_area_code' | 'location_code' | 'shipment_method_code'>;

const TEXT_FIELDS: { key: TextKey; label: string; maxLength?: number; placeholder?: string }[] = [
  { key: 'code', label: 'Code', maxLength: 10, placeholder: 'Leave blank to use the street address' },
  { key: 'name', label: 'Name', maxLength: 100 },
  { key: 'address', label: 'Address', maxLength: 100 },
  { key: 'address_2', label: 'Address 2', maxLength: 50 },
  { key: 'city', label: 'City', maxLength: 30 },
  { key: 'state', label: 'State', maxLength: 30 },
  { key: 'post_code', label: 'ZIP', maxLength: 20 },
  { key: 'country', label: 'Country', maxLength: 10 },
  { key: 'contact', label: 'Contact', maxLength: 100 },
  { key: 'phone', label: 'Phone', maxLength: 30 },
  { key: 'email', label: 'Email', maxLength: 80 },
];

const SELECT_FIELDS: { key: 'tax_area_code' | 'location_code' | 'shipment_method_code'; label: string; list: keyof ShipToOptions }[] = [
  { key: 'tax_area_code', label: 'Tax area', list: 'taxAreas' },
  { key: 'location_code', label: 'Location', list: 'locations' },
  { key: 'shipment_method_code', label: 'Shipment method', list: 'shipmentMethods' },
];

export function ShipToDialog({ customerNumber, row, options, onClose, onSaved }: Props) {
  const [values, setValues] = useState<ShipToValues>(() => (row ? pickValues(row) : EMPTY));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const set = <K extends keyof ShipToValues>(key: K, value: ShipToValues[K]) =>
    setValues((cur) => ({ ...cur, [key]: value }));

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await saveShipToAction({
        ...(row ? { id: row.id, code: row.code } : {}),
        customerNumber,
        values: row ? { ...values, code: row.code } : values,
      });
      if (res.ok) onSaved();
      else setError(res.error);
    });
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !pending) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{row ? 'Edit ship-to address' : 'Add ship-to address'}</DialogTitle>
          <DialogDescription>Saved to Business Central first, then to Nexus.</DialogDescription>
        </DialogHeader>
        {error && (
          <div role="alert" className="rounded-md border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {TEXT_FIELDS.map((f) => (
              <div key={f.key} className="space-y-1.5">
                <Label htmlFor={`shipto-${f.key}`} className="text-[11px] uppercase tracking-wide text-foreground-subtle">
                  {f.label}
                </Label>
                <Input
                  id={`shipto-${f.key}`}
                  value={values[f.key]}
                  maxLength={f.maxLength}
                  placeholder={f.placeholder}
                  disabled={pending || (f.key === 'code' && row !== null)}
                  onChange={(e) => set(f.key, f.key === 'code' ? e.target.value.toUpperCase() : e.target.value)}
                />
              </div>
            ))}
            {SELECT_FIELDS.map((f) => (
              <div key={f.key} className="space-y-1.5">
                <Label htmlFor={`shipto-${f.key}`} className="text-[11px] uppercase tracking-wide text-foreground-subtle">
                  {f.label}
                </Label>
                <select
                  id={`shipto-${f.key}`}
                  className={SELECT_CLASS}
                  value={values[f.key]}
                  disabled={pending}
                  onChange={(e) => set(f.key, e.target.value)}
                >
                  <option value="">—</option>
                  {options[f.list].map((o) => (
                    <option key={o.code} value={o.code}>{o.label}</option>
                  ))}
                </select>
              </div>
            ))}
            <div className="flex items-center gap-2 pt-5">
              <Switch
                id="shipto-tax_liable"
                checked={values.tax_liable}
                disabled={pending}
                onCheckedChange={(v) => set('tax_liable', v)}
              />
              <Label htmlFor="shipto-tax_liable" className="text-sm">Tax liable</Label>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>Cancel</Button>
            <Button type="submit" size="sm" disabled={pending}>{pending ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
