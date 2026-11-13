'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { SyncState } from '@/types/salesOrders';

interface Props {
  state: SyncState;
  error: string | null;
  /** False hides Try again / Overwrite (read-only users). */
  canAct?: boolean;
  busy?: boolean;
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

/** The order's sync state with BC, plus the action that fixes a failed or conflicting sync. */
export function SyncBadge({ state, error, canAct = true, busy = false, onRetry, onOverwrite }: Props) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className={`inline-flex items-center gap-1.5 ${TEXT[state]}`} role="status">
        <span aria-hidden className={`size-2 rounded-full ${DOT[state]}`} />
        {label(state, error)}
      </span>
      {canAct && state === 'failed' && (
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
