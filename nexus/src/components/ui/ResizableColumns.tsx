"use client";

// Column widths a person sets by dragging a column's right edge in a table's
// header row. Widths are remembered in this browser only (a per-viewer
// convenience); if storage is unavailable the defaults are used.
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

export const MIN_COLUMN_WIDTH = 60;
const KEY_STEP = 16;

const clamp = (w: number) => Math.max(MIN_COLUMN_WIDTH, Math.round(w));

function parseSaved<K extends string>(raw: string | null, defaults: Record<K, number>): Record<K, number> {
  const out = { ...defaults };
  try {
    const saved = JSON.parse(raw ?? "{}") as Record<string, unknown>;
    for (const k of Object.keys(defaults) as K[]) {
      const v = saved?.[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= MIN_COLUMN_WIDTH) out[k] = Math.round(v);
    }
  } catch {
    // Unreadable: defaults.
  }
  return out;
}

// Saved widths per table, kept in memory after the first read so every
// render sees the same value; storage is written on each change.
const memory = new Map<string, string | null>();
const listeners = new Set<() => void>();
function readStored(storageKey: string): string | null {
  if (!memory.has(storageKey)) {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(storageKey);
    } catch {
      // Storage blocked (private window etc.).
    }
    memory.set(storageKey, raw);
  }
  return memory.get(storageKey) ?? null;
}
function writeStored(storageKey: string, raw: string) {
  memory.set(storageKey, raw);
  try {
    window.localStorage.setItem(storageKey, raw);
  } catch {
    // Not remembered, but still applied for this visit.
  }
  listeners.forEach((l) => l());
}
/** Tests only: drop what was read, as a fresh page load would. */
export function forgetColumnWidthsForTests() {
  memory.clear();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Widths by column key, starting from `defaults`, saved under `storageKey`. */
export function useColumnWidths<K extends string>(storageKey: string, defaults: Record<K, number>) {
  // The server (and the first browser render) use the defaults; saved widths follow.
  const raw = useSyncExternalStore(subscribe, () => readStored(storageKey), () => null);
  const widths = useMemo(() => parseSaved(raw, defaults), [raw, defaults]);
  const setWidth = useCallback(
    (key: K, width: number) =>
      writeStored(storageKey, JSON.stringify({ ...parseSaved(readStored(storageKey), defaults), [key]: clamp(width) })),
    [storageKey, defaults],
  );
  const reset = useCallback(
    (key: K) => writeStored(storageKey, JSON.stringify({ ...parseSaved(readStored(storageKey), defaults), [key]: defaults[key] })),
    [storageKey, defaults],
  );
  return { widths, setWidth, reset };
}

interface HandleProps {
  /** Column name, for screen readers ("Resize Customer column"). */
  label: string;
  width: number;
  onResize: (width: number) => void;
  /** Double-click: back to the default width. */
  onReset: () => void;
}

/** The draggable right edge of a header cell. Put it inside a `relative` <th>. */
export function ColumnResizeHandle({ label, width, onResize, onReset }: HandleProps) {
  const drag = useRef<{ startX: number; startWidth: number; pointerId: number } | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label} column`}
      aria-valuenow={width}
      aria-valuemin={MIN_COLUMN_WIDTH}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      className="group absolute -right-1.5 top-0 z-10 flex h-full w-3 cursor-col-resize touch-none select-none justify-center outline-none"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        e.preventDefault();
        drag.current = { startX: e.clientX, startWidth: width, pointerId: e.pointerId };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.pointerId !== e.pointerId) return;
        onResize(d.startWidth + (e.clientX - d.startX));
      }}
      onPointerUp={(e) => {
        drag.current = null;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") onResize(width + KEY_STEP);
        else if (e.key === "ArrowLeft") onResize(width - KEY_STEP);
        else return;
        e.preventDefault();
      }}
    >
      <span className="h-full w-px bg-border transition-colors group-hover:w-0.5 group-hover:bg-primary group-focus-visible:w-0.5 group-focus-visible:bg-primary" />
    </div>
  );
}
