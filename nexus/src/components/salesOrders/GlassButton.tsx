'use client';

import { forwardRef, type ComponentProps } from 'react';
import { Button as GlisseButton } from 'glisse';

type Variant = 'default' | 'outline' | 'ghost' | 'destructive';
type Size = 'default' | 'sm' | 'icon' | 'icon-sm' | 'icon-xs';

interface Props extends Omit<ComponentProps<typeof GlisseButton>, 'variant'> {
  /** Same names as the app's shadcn Button: default = filled blue, destructive = filled red, outline/ghost = clear glass. */
  variant?: Variant;
  size?: Size;
}

// Glisse's stylesheet is unlayered, so it beats Tailwind's layered utilities: classes
// that must override it (size, position, colour) need the important suffix `!`.
const SIZE_CLASS: Record<Size, string> = {
  default: 'h-9! px-4! text-sm!',
  sm: 'h-8! px-3! text-sm!',
  icon: 'size-9! p-0! [&>svg]:size-4!',
  'icon-sm': 'size-7! p-0! [&>svg]:size-4!',
  'icon-xs': 'size-6! p-0! [&>svg]:size-3.5!',
};

/**
 * Liquid-glass button (Glisse) with the shadcn Button's variant and size names, for the sales order page.
 * A `className` that overrides Glisse's look needs `!` on each class (see SIZE_CLASS).
 */
export const GlassButton = forwardRef<HTMLButtonElement, Props>(function GlassButton(
  { variant = 'default', size = 'default', destructive, className, ...props },
  ref,
) {
  const filled = variant === 'default' || variant === 'destructive';
  return (
    <GlisseButton
      ref={ref}
      variant={filled ? 'filled' : 'glass'}
      {...props}
      destructive={variant === 'destructive' || destructive}
      className={`${SIZE_CLASS[size]} ${className ?? ''}`.trim()}
    />
  );
});
