'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SalesOrderItemOption } from '@/app/actions/salesOrders';
import { effectiveDiscount, effectivePrice, lineAmounts } from '@/lib/salesOrders/lineAmounts';
import type { LineDraft } from '@/types/salesOrders';

interface Props {
  lines: LineDraft[];
  items: SalesOrderItemOption[];
  locked: boolean;
  onChange: (lines: LineDraft[]) => void;
  /** The tax % for a line (0 when not given). */
  taxRate?: (line: LineDraft) => number;
  /** Show BC's read-back amount incl. tax instead of the live one (the order is synced and unchanged). */
  showBcAmounts?: boolean;
}

const cellInput =
  'w-full rounded border border-border bg-surface px-2 py-1 text-right text-sm text-foreground disabled:opacity-60';
const money = (n: number) => n.toFixed(2);
const LIST_MAX_HEIGHT = 256;
const LIST_WIDTH = 320;

type ListPosition = { top?: number; bottom?: number; left: number; maxHeight: number };

/**
 * Where the item list goes: fixed under the input (or above it when there is
 * more room there), so the table's scroll wrapper can't clip it.
 */
function listPositionFor(input: HTMLElement): ListPosition {
  const r = input.getBoundingClientRect();
  const below = window.innerHeight - r.bottom - 8;
  const above = r.top - 8;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - LIST_WIDTH - 8));
  if (below < 160 && above > below) {
    return { bottom: window.innerHeight - r.top + 4, left, maxHeight: Math.min(LIST_MAX_HEIGHT, above) };
  }
  return { top: r.bottom + 4, left, maxHeight: Math.min(LIST_MAX_HEIGHT, Math.max(below, 120)) };
}

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
  const inputRef = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState<ListPosition | null>(null);

  const show = useCallback(() => {
    if (inputRef.current) setPosition(listPositionFor(inputRef.current));
    setOpen(true);
  }, []);

  // Keep the list under the input while the page or the table scrolls.
  useEffect(() => {
    if (!open) return;
    const follow = () => {
      if (inputRef.current) setPosition(listPositionFor(inputRef.current));
    };
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    return () => {
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
    };
  }, [open]);

  const pick = (item: SalesOrderItemOption) => {
    onPick(item);
    setQuery('');
    setActive(0);
    setOpen(false);
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && matches.length > 0 ? optionId(activeIndex) : undefined}
        value={query}
        placeholder="Add item…"
        aria-label="Add item"
        autoComplete="off"
        className="w-full rounded border border-dashed border-border bg-surface px-2 py-1 text-sm text-foreground"
        onClick={show}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          show();
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!open) show();
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
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          // Outside the table's scroll wrapper, fixed under the input, so the list isn't clipped.
          <ul
            id={listId}
            role="listbox"
            className="fixed z-[10000] overflow-y-auto rounded border border-border bg-surface shadow-lg"
            style={{
              top: position?.top,
              bottom: position?.bottom,
              left: position?.left ?? 0,
              width: LIST_WIDTH,
              maxHeight: position?.maxHeight ?? LIST_MAX_HEIGHT,
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {matches.length === 0 ? (
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
            )}
          </ul>,
          document.body,
        )}
    </div>
  );
}

/**
 * Number cell that keeps the raw text while editing so it can be empty
 * mid-edit. Valid values commit on change; blur reverts invalid or empty input.
 */
function NumberCell({
  label,
  value,
  disabled,
  valid,
  onCommit,
}: {
  label: string;
  value: number;
  disabled: boolean;
  valid: (n: number) => boolean;
  onCommit: (n: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      type="number"
      aria-label={label}
      disabled={disabled}
      value={text ?? String(value)}
      className={cellInput}
      onChange={(e) => {
        setText(e.target.value);
        const n = parseNumber(e.target.value);
        if (n !== null && valid(n)) onCommit(n);
      }}
      onBlur={() => setText(null)}
    />
  );
}

/**
 * Price/discount cell: shows the value the line will use (typed, BC's or the
 * estimate) and holds the raw text while being typed. On blur an empty field
 * commits null (back to BC/estimate), a valid number commits it, anything
 * else reverts.
 */
function EffectiveCell({
  label,
  shown,
  disabled,
  step,
  valid,
  onCommit,
}: {
  label: string;
  shown: string;
  disabled: boolean;
  step: string;
  valid: (n: number) => boolean;
  onCommit: (n: number | null) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      type="number"
      aria-label={label}
      min={0}
      step={step}
      disabled={disabled}
      value={text ?? shown}
      className={cellInput}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== null) {
          const n = parseNumber(text);
          if (text.trim() === '') onCommit(null);
          else if (n !== null && valid(n)) onCommit(n);
        }
        setText(null);
      }}
    />
  );
}

const shownPrice = (l: LineDraft) => {
  const p = effectivePrice(l);
  return p === null ? '' : money(p);
};
const shownDiscount = (l: LineDraft) => {
  const d = effectiveDiscount(l);
  return d === 0 ? '' : String(d);
};

export function SalesOrderLinesTable({ lines, items, locked, onChange, taxRate, showBcAmounts = false }: Props) {
  const update = (key: string, patch: Partial<LineDraft>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const amountOf = (l: LineDraft) =>
    showBcAmounts && l.amount_incl_tax !== null ? l.amount_incl_tax : lineAmounts(l, taxRate?.(l) ?? 0).incl;

  const addItem = (item: SalesOrderItemOption) =>
    onChange([
      ...lines,
      {
        key: crypto.randomUUID(),
        item_number: item.bc_item_number,
        description: item.display_name,
        quantity: 1,
        unit_price: null,
        // null = BC decides (its price-list discount applies).
        discount_percent: null,
        unit_of_measure_code: item.base_unit_of_measure_code ?? '',
        amount_incl_tax: null,
        estimate_price: item.unit_price,
        bc_unit_price: null,
        bc_line_discount_percent: null,
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
                  // BC's price, discount and amount were for the old quantity; the estimate takes over.
                  onCommit={(n) =>
                    update(line.key, { quantity: n, bc_unit_price: null, bc_line_discount_percent: null, amount_incl_tax: null })
                  }
                />
              </td>
              <td className="w-36 px-3 py-2">
                <EffectiveCell
                  label="Unit price"
                  step="0.01"
                  disabled={locked}
                  shown={shownPrice(line)}
                  valid={(n) => n >= 0}
                  onCommit={(n) => update(line.key, { unit_price: n })}
                />
              </td>
              <td className="w-24 px-3 py-2">
                <EffectiveCell
                  label="Disc %"
                  step="0.01"
                  disabled={locked}
                  shown={shownDiscount(line)}
                  valid={(n) => n >= 0 && n <= 100}
                  onCommit={(n) => update(line.key, { discount_percent: n })}
                />
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right text-foreground-muted">{money(amountOf(line))}</td>
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
