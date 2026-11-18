const MAX_LENGTH = 10;
const FALLBACK = 'SHIPTO';

/**
 * Builds a ship-to code (max 10 chars, uppercase) from a street address.
 * Keeps only A-Z and 0-9 from the uppercased street, and appends -n
 * (n = 2, 3, ...) when the base is already taken. Comparison against
 * `taken` is case-insensitive.
 */
export function makeShipToCode(street: string, taken: ReadonlySet<string>): string {
  const base =
    street.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, MAX_LENGTH) || FALLBACK;

  const takenUpper = new Set(Array.from(taken, (code) => code.toUpperCase()));
  if (!takenUpper.has(base)) return base;

  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, MAX_LENGTH - suffix.length) + suffix;
    if (!takenUpper.has(candidate)) return candidate;
  }
}
