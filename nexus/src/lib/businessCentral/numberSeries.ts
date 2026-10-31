// Pure helpers for BC-style number formatting: prefix + zero-padded digits + optional suffix.

const NO_FORMAT = /^(.*?)(\d+)(\D*)$/;

export function parseNoFormat(
  sample: string,
): { prefix: string; pad: number; suffix: string } | null {
  const match = NO_FORMAT.exec(sample ?? '');
  if (!match) return null;
  const [, prefix, digits, suffix] = match;
  return { prefix, pad: digits.length, suffix };
}

export function incrementNo(current: string, increment: number, startingNo: string): string {
  if (!current) return startingNo;
  const format = parseNoFormat(current) ?? parseNoFormat(startingNo);
  if (!format) return startingNo;
  const digits = NO_FORMAT.exec(current)?.[2] ?? '0';
  const nextValue = Number.parseInt(digits, 10) + increment;
  const padded = String(nextValue).padStart(format.pad, '0');
  return `${format.prefix}${padded}${format.suffix}`;
}

function numericPart(value: string): number {
  return Number.parseInt(NO_FORMAT.exec(value)?.[2] ?? '0', 10);
}
function prefixPart(value: string): string {
  return NO_FORMAT.exec(value)?.[1] ?? value;
}

export function compareNo(a: string, b: string): number {
  if (prefixPart(a) === prefixPart(b)) {
    const na = numericPart(a);
    const nb = numericPart(b);
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  return a === b ? 0 : a < b ? -1 : 1;
}

export function isWithinRange(candidate: string, startingNo: string, endingNo: string): boolean {
  if (prefixPart(candidate) !== prefixPart(startingNo)) return false;
  // BC: a blank ending number means the series is unlimited.
  if (!endingNo?.trim()) return compareNo(candidate, startingNo) >= 0;
  return compareNo(candidate, startingNo) >= 0 && compareNo(candidate, endingNo) <= 0;
}
