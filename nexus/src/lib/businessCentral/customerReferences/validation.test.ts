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
  it('date formula accepts every BC unit, C prefix, signs and combinations', () => {
    for (const ok of ['5WD', 'CWD', '10D', '2W', '1M', '1Q', '1Y', 'CD', 'CW', 'CM', 'CQ', 'CY', 'CM+10D', '1M+CM', '-1W', '+1W',
      '-CM', 'CM-1D', '1Y-1D+CM', ' 30D ', '5wd', 'cm+10d', 'D10', 'WD2']) {
      expect(validateEntry([df], { due_date_calculation: ok }), ok).toEqual([]);
    }
    for (const bad of ['10', 'D', 'CM+', '1X', '++1D', 'C', '1MM', 'CM 10D']) {
      expect(validateEntry([df], { due_date_calculation: bad }), bad).toEqual(['Use a BC date formula like 30D, 1M or CM']);
    }
  });
  it('effective date required and real', () => {
    expect(validateEntry([eff], { effective_date: '' })).toEqual(['Effective Date is required']);
    expect(validateEntry([eff], { effective_date: '2025-02-30' })).toEqual(['Effective Date must be a valid date']);
    expect(validateEntry([eff], { effective_date: 'nope' })).toEqual(['Effective Date must be a valid date']);
    expect(validateEntry([eff], { effective_date: '2025-02-28' })).toEqual([]);
  });
  it("accepts BC's blank date 0001-01-01 and checks leap years without the two-digit-year pitfall", () => {
    for (const ok of ['0001-01-01', '0099-12-31', '2024-02-29', '2000-02-29', '1999-12-31']) {
      expect(validateEntry([eff], { effective_date: ok }), ok).toEqual([]);
    }
    for (const bad of ['2023-02-29', '1900-02-29', '2025-13-01', '2025-00-10', '2025-04-31', '0000-01-01', '2025-01-00']) {
      expect(validateEntry([eff], { effective_date: bad }), bad).toEqual(['Effective Date must be a valid date']);
    }
  });
});
