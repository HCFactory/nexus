import type { FieldSpec } from '@/types/customerReferences';

const TERM = '(?:\\d+[DWMQY]|C[DWMQY])';
const DATE_FORMULA = new RegExp(`^(?:CM|CQ|CY|CW|[+-]?${TERM})(?:[+-]${TERM})*$`, 'i');

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function isRealDate(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
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
