/**
 * The SVG filter behind `.glass-card` (globals.css): soft noise that warps the
 * blurred backdrop for a liquid-glass look. Render it once on a page that uses
 * glass cards. Browsers without SVG backdrop filters just show the blur.
 */
export function GlassFilter() {
  return (
    <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: 'absolute' }}>
      <defs>
        <filter id="glass-distortion" x="0%" y="0%" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.01 0.01" numOctaves={2} seed={92} result="noise" />
          <feGaussianBlur in="noise" stdDeviation={2} result="blurred" />
          <feDisplacementMap in="SourceGraphic" in2="blurred" scale={55} xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    </svg>
  );
}
