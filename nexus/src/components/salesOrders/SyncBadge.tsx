'use client';

import { useEffect, useState } from 'react';

import { GlassButton as Button } from './GlassButton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { SyncState } from '@/types/salesOrders';

interface Props {
  state: SyncState;
  error: string | null;
  /** False hides Try again / Overwrite (read-only users). */
  canAct?: boolean;
  busy?: boolean;
  /** The order's lease and last update; a pending order with neither recent offers Try again. */
  claimedUntil?: string | null;
  updatedAt?: string | null;
  onRetry: () => void;
  onOverwrite: () => void;
}

const DOT: Record<SyncState, string> = {
  pending: 'bg-sky-500',
  synced: 'bg-green-500',
  failed: 'bg-red-500',
  conflict: 'bg-amber-500',
};

const TEXT: Record<SyncState, string> = {
  pending: 'text-foreground-muted',
  synced: 'text-foreground',
  failed: 'text-destructive',
  conflict: 'text-warning',
};

function label(state: SyncState, error: string | null): string {
  if (state === 'pending') return 'Sending to BC…';
  if (state === 'synced') return 'In BC';
  if (state === 'failed') return `Failed: ${error || 'BC error'}`;
  return 'Changed in BC';
}

/** A pending order counts as stuck once nothing has touched it for this long and no sync holds it. */
const STUCK_AFTER_MS = 30_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * True once a pending order looks stuck: no live claim and last updated more
 * than 30s ago. Checked by a timer, so the button appears while the page is open.
 */
function useStuck(state: SyncState, claimedUntil: string | null | undefined, updatedAt: string | null | undefined) {
  const key = `${state}|${claimedUntil ?? ''}|${updatedAt ?? ''}`;
  const [stuckKey, setStuckKey] = useState<string | null>(null);
  useEffect(() => {
    if (state !== 'pending' || !updatedAt) return;
    const updated = Date.parse(updatedAt);
    if (!Number.isFinite(updated)) return;
    const claim = claimedUntil ? Date.parse(claimedUntil) : 0;
    const at = Math.max(updated + STUCK_AFTER_MS, Number.isFinite(claim) ? claim + 1 : 0);
    const delay = at - Date.now();
    if (delay > MAX_TIMEOUT_MS) return;
    const t = setTimeout(() => setStuckKey(key), Math.max(0, delay));
    return () => clearTimeout(t);
  }, [key, state, claimedUntil, updatedAt]);
  return stuckKey === key;
}

/** The order's sync state with BC, plus the action that fixes a failed, stuck or conflicting sync. */
export function SyncBadge({
  state,
  error,
  canAct = true,
  busy = false,
  claimedUntil,
  updatedAt,
  onRetry,
  onOverwrite,
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const stuck = useStuck(state, claimedUntil, updatedAt);

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className={`inline-flex items-center gap-1.5 ${TEXT[state]}`} role="status">
        <span aria-hidden className={`size-2 rounded-full ${DOT[state]}`} />
        {label(state, error)}
      </span>
      {canAct && (state === 'failed' || (state === 'pending' && stuck)) && (
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onRetry}>
          Try again
        </Button>
      )}
      {canAct && state === 'conflict' && (
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(true)}>
          Overwrite BC with Nexus&apos;s version
        </Button>
      )}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Overwrite BC with Nexus&apos;s version?</DialogTitle>
            <DialogDescription>
              Someone changed this order in Business Central. Overwriting replaces their changes with the order as it is
              in Nexus, and removes lines that were only added in BC.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                onOverwrite();
              }}
            >
              Overwrite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
