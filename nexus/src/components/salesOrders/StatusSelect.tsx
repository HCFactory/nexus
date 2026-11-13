'use client';

import { canChangeStatus } from '@/lib/salesOrders/orderRules';
import { ORDER_STATUSES, type OrderStatus } from '@/types/salesOrders';

export const STATUS_LABELS: Record<OrderStatus, string> = {
  draft: 'Draft',
  final: 'Final',
  pulled: 'Pulled',
  shipped: 'Shipped',
  invoiced: 'Invoiced',
};

export const STATUS_CLASSES: Record<OrderStatus, string> = {
  draft: 'bg-gray-100 text-gray-700 border-gray-300 dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600',
  final: 'bg-yellow-100 text-yellow-800 border-yellow-300 dark:bg-yellow-900/40 dark:text-yellow-200 dark:border-yellow-700',
  pulled: 'bg-orange-100 text-orange-800 border-orange-300 dark:bg-orange-900/40 dark:text-orange-200 dark:border-orange-700',
  shipped: 'bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-900/40 dark:text-blue-200 dark:border-blue-700',
  invoiced: 'bg-green-100 text-green-800 border-green-300 dark:bg-green-900/40 dark:text-green-200 dark:border-green-700',
};

interface Props {
  value: OrderStatus;
  onChange: (status: OrderStatus) => void;
  disabled?: boolean;
}

/** Status dropdown. Shipped and Invoiced are set by BC-side buttons, never by hand. */
export function StatusSelect({ value, onChange, disabled = false }: Props) {
  // Once BC owns the status (shipped/invoiced) nothing can be picked by hand.
  const fixed = !canChangeStatus(value, 'draft');
  return (
    <select
      aria-label="Status"
      value={value}
      disabled={disabled || fixed}
      onChange={(e) => onChange(e.target.value as OrderStatus)}
      className={`h-9 rounded-full border px-3 text-sm font-medium disabled:opacity-70 ${STATUS_CLASSES[value]}`}
    >
      {ORDER_STATUSES.map((s) => (
        <option key={s} value={s} disabled={!canChangeStatus('draft', s)} className={STATUS_CLASSES[s]}>
          {STATUS_LABELS[s]}
        </option>
      ))}
    </select>
  );
}
