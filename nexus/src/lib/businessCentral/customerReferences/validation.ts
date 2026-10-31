import type { FieldSpec } from '@/types/customerReferences';

// BC date formula units: D, WD (weekday), W, M, Q, Y. A term is a number then a
// unit (10D, 5WD), C then a unit for "current period" (CM, CWD), or a unit then a
// number for "next day/weekday N" (D10, WD2). Terms are joined with + or -, and
// the first may carry a sign: CM+10D, 1M+CM, -1W.
const UNIT = '(?:WD|[DWMQY])';
const TERM = `(?:\\d+${UNIT}|C${UNIT}|${UNIT}\\d+)`;
const DATE_FORMULA = new RegExp(`^[+-]?${TERM}(?:[+-]${TERM})*$`, 'i');

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function isRealDate(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Checked by hand: Date.UTC maps years 0-99 to 1900-1999, which would reject
  // BC's blank date 0001-01-01.
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return d <= daysInMonth;
}

/** Returns user-facing messages; [] means valid. Runs in the browser too. */
export function validateEntry(fields: FieldSpec[], values: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const f of fields) {
    const v = values[f.name];
    if (isBlank(v)) {
      if (f.required) errors.push(`${f.label} is required`);
      continue;
    }
    if (f.type === 'text' && f.maxLength !== undefined && String(v).length > f.maxLength) {
      errors.push(`${f.label} can be at most ${f.maxLength} characters`);
    } else if (f.type === 'percent') {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 100) errors.push(`${f.label} must be between 0 and 100`);
    } else if (f.type === 'dateFormula') {
      if (!DATE_FORMULA.test(String(v).trim())) errors.push('Use a BC date formula like 30D, 1M or CM');
    } else if (f.type === 'date') {
      if (!isRealDate(v)) errors.push(`${f.label} must be a valid date`);
    } else if (f.type === 'number') {
      if (!Number.isFinite(typeof v === 'number' ? v : Number(v))) errors.push(`${f.label} must be a number`);
    }
  }
  return errors;
}
