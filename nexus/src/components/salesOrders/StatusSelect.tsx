'use client';

import { ChevronDown } from 'lucide-react';
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

/** Label colour per status for the glass pill (the coloured fills stay for list badges). */
const STATUS_TEXT: Record<OrderStatus, string> = {
  draft: 'text-foreground',
  final: 'text-yellow-700 dark:text-yellow-300',
  pulled: 'text-orange-700 dark:text-orange-300',
  shipped: 'text-blue-700 dark:text-blue-300',
  invoiced: 'text-green-700 dark:text-green-300',
};

/** Same look as the Glisse glass buttons beside it: 36px pill, frosted fill, hairline edge, soft drop. */
const GLASS_PILL =
  'h-9 appearance-none rounded-full pl-4 pr-9 text-sm font-medium outline-none transition-colors ' +
  'bg-white/60 backdrop-blur-sm shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.08),0_1px_3px_rgb(0_0_0/0.12)] hover:bg-[rgb(236_236_240/0.85)] ' +
  'dark:bg-[rgb(40_40_40/0.62)] dark:shadow-[inset_0_0_0_0.5px_rgb(255_255_255/0.08),0_1px_3px_rgb(0_0_0/0.3)] dark:hover:bg-[rgb(70_70_70/0.62)] ' +
  'focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-70 disabled:hover:bg-white/60 dark:disabled:hover:bg-[rgb(40_40_40/0.62)]';

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
    <span className="relative inline-flex">
      <select
        aria-label="Status"
        value={value}
        disabled={disabled || fixed}
        onChange={(e) => onChange(e.target.value as OrderStatus)}
        className={`${GLASS_PILL} ${STATUS_TEXT[value]}`}
      >
        {ORDER_STATUSES.map((s) => (
          <option key={s} value={s} disabled={!canChangeStatus('draft', s)} className="bg-surface text-foreground">
            {STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-3.5 top-1/2 size-4 -translate-y-1/2 text-foreground-muted" />
    </span>
  );}
