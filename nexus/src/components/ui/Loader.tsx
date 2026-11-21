// Loading indicators: a candy-coloured spinning ring in a frosted pill, and a
// thin candy bar sliding across the top of whatever is loading. Animations
// live in globals.css (.candy-ring, .candy-bar, .loader-in); with "reduce
// motion" turned on they gently pulse instead.
import { cn } from "@/lib/utils";

/** The spinning candy ring, with a soft glow behind it. */
export function CandySpinner({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <span data-loader="spinner" aria-hidden className={cn("relative inline-block shrink-0", className)} style={{ width: size, height: size }}>
      <span className="candy-ring absolute inset-0 opacity-60 blur-[6px]" />
      <span className="candy-ring absolute inset-0" />
    </span>
  );
}

function LoaderPill({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2.5 rounded-full border border-border bg-surface-raised/95 px-4 py-2 text-sm font-medium text-foreground shadow-xl backdrop-blur-md"
    >
      <CandySpinner />
      {label}
    </div>
  );
}

/**
 * Over content that is reloading (put it inside a `relative` box): a sliding
 * bar along the top and a floating pill. Fades in after a moment so quick
 * loads don't flicker; never blocks clicks.
 */
export function LoadingOverlay({ show, label = "Loading…" }: { show: boolean; label?: string }) {
  if (!show) return null;
  return (
    <div data-loader="overlay" className="loader-in pointer-events-none absolute inset-0 z-20">
      <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden">
        <div data-loader="bar" className="candy-bar h-full w-2/5" />
      </div>
      <div className="flex justify-center pt-16">
        <LoaderPill label={label} />
      </div>
    </div>
  );
}

/** Full-area loader for page changes. */
export function PageLoader({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loader-in flex h-full min-h-[50vh] items-center justify-center">
      <LoaderPill label={label} />
    </div>
  );
}
