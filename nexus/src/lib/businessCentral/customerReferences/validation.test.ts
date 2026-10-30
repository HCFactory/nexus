import { describe, expect, it } from 'vitest';
import { validateEntry } from './validation';
import type { FieldSpec } from '@/types/customerReferences';

const code: FieldSpec = { name: 'code', bcName: 'code', label: 'Code', type: 'text', required: true, isKey: true, editable: true, maxLength: 10 };
const pct: FieldSpec = { name: 'discount_pct', bcName: 'd', label: 'Discount %', type: 'percent', editable: true };
const df: FieldSpec = { name: 'due_date_calculation', bcName: 'x', label: 'Due Date Calculation', type: 'dateFormula', editable: true };
const eff: FieldSpec = { name: 'effective_date', bcName: 'e', label: 'Effective Date', type: 'date', required: true, editable: true };

describe('validateEntry', () => {
  it('percent 7 is valid', () => {
    const v = { discount_pct: 7 };
    expect(validateEntry([pct], v)).toEqual([]);
    expect(v.discount_pct).toBe(7);
  });
  it('percent out of range', () => {
    expect(validateEntry([pct], { discount_pct: -1 })).toEqual(['Discount % must be between 0 and 100']);
    expect(validateEntry([pct], { discount_pct: 100.01 })).toEqual(['Discount % must be between 0 and 100']);
    const tb: FieldSpec = { ...pct, name: 'tax_below_maximum', label: 'Tax below maximum' };
    expect(validateEntry([tb], { tax_below_maximum: 101 })).toEqual(['Tax below maximum must be between 0 and 100']);
  });
  it('code required and max length', () => {
    expect(validateEntry([code], { code: '' })).toEqual(['Code is required']);
    expect(validateEntry([code], { code: null })).toEqual(['Code is required']);
    expect(validateEntry([code], { code: 'ABCDEFGHIJK' })).toEqual(['Code can be at most 10 characters']);
    expect(validateEntry([{ ...code, maxLength: 20 }], { code: 'ABCDEFGHIJK' })).toEqual([]);
    expect(validateEntry([code], { code: 'NET30' })).toEqual([]);
  });
  it('date formula', () => {
    for (const ok of ['30D', '1M', 'CM', 'CM+1M', '1M+5D', 'cm']) expect(validateEntry([df], { due_date_calculation: ok })).toEqual([]);
    for (const bad of ['30 days', 'abc']) expect(validateEntry([df], { due_date_calculation: bad })).toEqual(['Use a BC date formula like 30D, 1M or CM']);
    expect(validateEntry([df], { due_date_calculation: '' })).toEqual([]);
  });
  it('effective date required and real', () => {
    expect(validateEntry([eff], { effective_date: '' })).toEqual(['Effective Date is required']);
    expect(validateEntry([eff], { effective_date: '2025-02-30' })).toEqual(['Effective Date must be a valid date']);
    expect(validateEntry([eff], { effective_date: 'nope' })).toEqual(['Effective Date must be a valid date']);
    expect(validateEntry([eff], { effective_date: '2025-02-28' })).toEqual([]);
  });
});
