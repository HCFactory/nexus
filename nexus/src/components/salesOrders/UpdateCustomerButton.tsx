'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { setCustomerDeliveryMethod } from '@/app/actions/customerEditing';
import { GlassButton as Button } from './GlassButton';

/**
 * "Update Customer": saves the order's delivery method as the customer's
 * default. Shown only when the two differ; changes nothing else on the customer.
 */
export function UpdateCustomerButton({
  customerId,
  customerNumber,
  orderMethod,
  customerMethod,
}: {
  customerId: string;
  customerNumber: string;
  orderMethod: string;
  customerMethod: string;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = saved ?? customerMethod;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await setCustomerDeliveryMethod(customerId, orderMethod);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSaved(orderMethod);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the customer.');
    } finally {
      setBusy(false);
    }
  };

  if (orderMethod === current) {
    return saved !== null ? (
      <p role="status" className="text-xs text-foreground-muted">Saved as {customerNumber}&apos;s default delivery method.</p>
    ) : null;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={save}>
        {busy ? 'Saving…' : 'Update Customer'}
      </Button>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
