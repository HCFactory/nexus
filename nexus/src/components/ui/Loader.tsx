// Loading indicators: a neon-blue spinning ring with a glow, and a thin neon
// bar sliding across the top of whatever is loading. Graphic only; the label
// is read out to screen readers. Animations live in globals.css (.neon-ring,
// .neon-bar, .loader-in); with "reduce motion" turned on they gently pulse.
import { cn } from "@/lib/utils";

/** The spinning neon ring: a glowing comet tail chasing round a faint track. */
export function NeonSpinner({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <span data-loader="spinner" aria-hidden className={cn("neon-spinner relative inline-block shrink-0", className)} style={{ width: size, height: size }}>
      <span className="neon-track absolute inset-0" />
      <span className="neon-ring absolute inset-0" />
    </span>
  );
}

function LoaderGraphic({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite">
      <NeonSpinner />
      <span className="sr-only">{label}</span>
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
        <div data-loader="bar" className="neon-bar h-full w-2/5" />
      </div>
      <div className="flex justify-center pt-16">
        <LoaderGraphic label={label} />
      </div>
    </div>
  );
}

/** Full-area loader for page changes. */
export function PageLoader({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loader-in flex h-full min-h-[50vh] items-center justify-center">
      <LoaderGraphic label={label} />
    </div>
  );
}
