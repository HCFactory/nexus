'use client';

import { useId, useMemo, useState } from 'react';
import type { SalesOrderItemOption } from '@/app/actions/salesOrders';
import type { LineDraft } from '@/types/salesOrders';

interface Props {
  lines: LineDraft[];
  items: SalesOrderItemOption[];
  locked: boolean;
  onChange: (lines: LineDraft[]) => void;
}

const cellInput =
  'w-full rounded border border-border bg-surface px-2 py-1 text-right text-sm text-foreground disabled:opacity-60';
const money = (n: number) => n.toFixed(2);
const parseNumber = (raw: string): number | null => {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

function ItemPicker({ items, onPick }: { items: SalesOrderItemOption[]; onPick: (item: SalesOrderItemOption) => void }) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? items.filter((i) => `${i.bc_item_number} ${i.display_name}`.toLowerCase().includes(q))
      : items;
    return list.slice(0, 50);
  }, [items, query]);
  const activeIndex = Math.min(active, Math.max(matches.length - 1, 0));
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const pick = (item: SalesOrderItemOption) => {
    onPick(item);
    setQuery('');
    setActive(0);
    setOpen(false);
  };

  return (
    <div className="relative">
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches.length > 0 ? optionId(activeIndex) : undefined}
        value={query}
        placeholder="Add item…"
        aria-label="Add item"
        autoComplete="off"
        className="w-full rounded border border-dashed border-border bg-surface px-2 py-1 text-sm text-foreground"
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
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
            setOpen(false);
          }
        }}
      />
      <ul
        id={listId}
        role="listbox"
        hidden={!open}
        className="absolute left-0 z-20 mt-1 max-h-64 w-80 overflow-y-auto rounded border border-border bg-surface shadow-lg"
        onMouseDown={(e) => e.preventDefault()}
      >
        {open &&
          (matches.length === 0 ? (
            <li className="px-3 py-2 text-xs text-foreground-subtle">No matching items.</li>
          ) : (
            matches.map((item, i) => (
              <li
                key={item.bc_item_number}
                id={optionId(i)}
                role="option"
                aria-selected={i === activeIndex}
                className={`cursor-pointer px-3 py-1.5 text-sm text-foreground hover:bg-surface-raised ${
                  i === activeIndex ? 'bg-surface-raised' : ''
                }`}
                onClick={() => pick(item)}
              >
                {`${item.bc_item_number} – ${item.display_name}`}
              </li>
            ))
          ))}
      </ul>
    </div>
  );
}

/**
 * Number cell that keeps the raw text while editing so it can be empty
 * mid-edit. Valid values commit on change; blur reverts invalid input, and an
 * empty field commits `emptyValue` (or reverts when that is null).
 */
function NumberCell({
  label,
  value,
  disabled,
  step,
  valid,
  emptyValue,
  onCommit,
}: {
  label: string;
  value: number;
  disabled: boolean;
  step?: string;
  valid: (n: number) => boolean;
  emptyValue: number | null;
  onCommit: (n: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      type="number"
      aria-label={label}
      step={step}
      disabled={disabled}
      value={text ?? String(value)}
      className={cellInput}
      onChange={(e) => {
        setText(e.target.value);
        const n = parseNumber(e.target.value);
        if (n !== null && valid(n)) onCommit(n);
      }}
      onBlur={() => {
        if (text !== null && text.trim() === '' && emptyValue !== null) onCommit(emptyValue);
        setText(null);
      }}
    />
  );
}

export function SalesOrderLinesTable({ lines, items, locked, onChange }: Props) {
  const update = (key: string, patch: Partial<LineDraft>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const addItem = (item: SalesOrderItemOption) =>
    onChange([
      ...lines,
      {
        key: crypto.randomUUID(),
        item_number: item.bc_item_number,
        description: item.display_name,
        quantity: 1,
        unit_price: null,
        discount_percent: 0,
        unit_of_measure_code: item.base_unit_of_measure_code ?? '',
        amount_incl_tax: null,
        estimate_price: item.unit_price,
        bc_unit_price: null,
      },
    ]);

  return (
    <div className="overflow-x-auto rounded border border-border">
      <table className="min-w-full divide-y divide-border text-sm">
        <thead className="bg-surface-raised text-left text-xs uppercase tracking-wide text-foreground-subtle">
          <tr>
            <th className="px-3 py-2 font-medium">Item</th>
            <th className="px-3 py-2 text-right font-medium">Qty</th>
            <th className="px-3 py-2 text-right font-medium">Unit price</th>
            <th className="px-3 py-2 text-right font-medium">Disc %</th>
            <th className="px-3 py-2 text-right font-medium">Amount incl. tax</th>
            <th className="w-10 px-3 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border bg-surface">
          {lines.map((line) => (
            <tr key={line.key}>
              <td className="min-w-56 px-3 py-2 text-foreground">
                <span className="font-mono text-foreground-muted">{line.item_number}</span>
                {line.description && <span className="ml-2">{line.description}</span>}
              </td>
              <td className="w-24 px-3 py-2">
                <NumberCell
                  label="Qty"
                  disabled={locked}
                  value={line.quantity}
                  valid={(n) => n > 0}
                  emptyValue={null}
                  onCommit={(n) => update(line.key, { quantity: n })}
                />
              </td>
              <td className="w-36 px-3 py-2">
                <input
                  type="number"
                  aria-label="Unit price"
                  min={0}
                  step="0.01"
                  disabled={locked}
                  value={line.unit_price ?? ''}
                  className={cellInput}
                  onChange={(e) => update(line.key, { unit_price: parseNumber(e.target.value) })}
                />
                {line.unit_price === null &&
                  (line.bc_unit_price !== null ? (
                    <span className="mt-0.5 block text-right text-xs text-foreground-subtle">
                      {money(line.bc_unit_price)}
                    </span>
                  ) : (
                    line.estimate_price !== null && (
                      <span className="mt-0.5 block text-right text-xs text-foreground-subtle">
                        {`${money(line.estimate_price)} (est.)`}
                      </span>
                    )
                  ))}
              </td>
              <td className="w-24 px-3 py-2">
                <NumberCell
                  label="Disc %"
                  step="0.01"
                  disabled={locked}
                  value={line.discount_percent}
                  valid={(n) => n >= 0 && n <= 100}
                  emptyValue={0}
                  onCommit={(n) => update(line.key, { discount_percent: n })}
                />
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right text-foreground-muted">
                {line.amount_incl_tax === null ? '—' : money(line.amount_incl_tax)}
              </td>
              <td className="px-3 py-2 text-right">
                <button
                  type="button"
                  aria-label="Remove line"
                  disabled={locked}
                  onClick={() => onChange(lines.filter((l) => l.key !== line.key))}
                  className="rounded px-2 py-1 text-foreground-muted hover:text-destructive disabled:opacity-40"
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
          {!locked && (
            <tr>
              <td className="px-3 py-2">
                <ItemPicker items={items} onPick={addItem} />
              </td>
              <td colSpan={5} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
