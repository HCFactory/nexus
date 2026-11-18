'use client';

import { useState } from 'react';

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { formatMoney } from '@/lib/format';
import { GlassButton as Button } from './GlassButton';

const REASON_MAX = 1000;

interface Props {
  open: boolean;
  /** The invoice total today (incl. tax). */
  oldTotal: number | null;
  /** The corrected lines' subtotal before tax. */
  newSubtotal: number;
  oldBcNumber: string;
  /** Starts the change; returns an error to show, or null when it started. */
  onConfirm: (reason: string) => Promise<string | null>;
  onClose: () => void;
}

/** The reason popup for "Save changes to invoice". */
export function ChangeInvoiceDialog({ open, oldTotal, newSubtotal, oldBcNumber, onConfirm, onClose }: Props) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const err = await onConfirm(reason.trim());
      if (err) setError(err);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the invoice.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Save changes to invoice?</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-1">
              <p>
                Total: {formatMoney(oldTotal, null)} → {formatMoney(newSubtotal, null)} before tax (BC recalculates tax)
              </p>
              <p className="pt-1 font-medium text-foreground">
                BC will cancel {oldBcNumber} and post a corrected invoice. This can&apos;t be undone.
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="change-reason" className="text-black dark:text-white">Reason</Label>
          <textarea
            id="change-reason"
            className="min-h-24 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground"
            maxLength={REASON_MAX}
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="text-right text-xs text-foreground-muted">{reason.length} / {REASON_MAX}</p>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onClose}>Back</Button>
          <Button type="button" size="sm" variant="blue-glass" disabled={busy || !reason.trim()} onClick={confirm}>
            {busy ? 'Saving…' : 'Confirm'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
