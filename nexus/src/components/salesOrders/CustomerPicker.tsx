'use client';

import { useId, useMemo, useState } from 'react';
import type { CustomerRow } from '@/types/salesOrders';

interface Props {
  customers: CustomerRow[];
  /** What the box shows when not searching, e.g. "C00125 – Acme Foods" ('' = none picked). */
  selectedLabel: string;
  disabled: boolean;
  onPick: (customer: CustomerRow) => void;
}

export const customerLabel = (number: string, name: string) => (number ? `${number} – ${name}` : '');

/** Searchable customer dropdown (same keyboard pattern as the lines table's item picker). */
export function CustomerPicker({ customers, selectedLabel, disabled, onPick }: Props) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const matches = useMemo(() => {
    const q = (query ?? '').trim().toLowerCase();
    const list = q
      ? customers.filter((c) => `${c.bc_customer_number ?? ''} ${c.display_name}`.toLowerCase().includes(q))
      : customers;
    return list.slice(0, 50);
  }, [customers, query]);
  const activeIndex = Math.min(active, Math.max(matches.length - 1, 0));
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const close = () => {
    setOpen(false);
    setQuery(null);
    setActive(0);
  };
  const pick = (c: CustomerRow) => {
    onPick(c);
    close();
  };

  return (
    <div className="relative">
      <input
        id="so-customer"
        type="text"
        role="combobox"
        aria-label="Customer"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches.length > 0 ? optionId(activeIndex) : undefined}
        value={query ?? selectedLabel}
        placeholder="Pick a customer…"
        autoComplete="off"
        disabled={disabled}
        className="h-9 w-full rounded-md border border-input bg-field px-3 text-sm text-foreground shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
        onFocus={(e) => {
          e.currentTarget.select();
          setOpen(true);
        }}
        onBlur={close}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive(Math.min(activeIndex + 1, matches.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive(Math.max(activeIndex - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (open && matches[activeIndex]) pick(matches[activeIndex]);
          } else if (e.key === 'Escape') {
            close();
          }
        }}
      />
      <ul
        id={listId}
        role="listbox"
        hidden={!open}
        className="absolute left-0 z-20 mt-1 max-h-64 w-full min-w-80 overflow-y-auto rounded border border-border bg-surface shadow-lg"
        onMouseDown={(e) => e.preventDefault()}
      >
        {open &&
          (matches.length === 0 ? (
            <li className="px-3 py-2 text-xs text-foreground-subtle">No matching customers.</li>
          ) : (
            matches.map((c, i) => (
              <li
                key={c.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === activeIndex}
                className={`cursor-pointer px-3 py-1.5 text-sm ${
                  i === activeIndex ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-primary/15'
                }`}
                onClick={() => pick(c)}
              >
                {customerLabel(c.bc_customer_number ?? '', c.display_name)}
              </li>
            ))
          ))}
      </ul>
    </div>
  );
}
