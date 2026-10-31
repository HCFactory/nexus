import { describe, expect, it } from 'vitest';
import { parseNoFormat, incrementNo, compareNo, isWithinRange } from './numberSeries';

describe('parseNoFormat', () => {
  it('splits prefix, pad width, and suffix', () => {
    expect(parseNoFormat('NX000001')).toEqual({ prefix: 'NX', pad: 6, suffix: '' });
    expect(parseNoFormat('CHOC0001')).toEqual({ prefix: 'CHOC', pad: 4, suffix: '' });
    expect(parseNoFormat('A00001-X')).toEqual({ prefix: 'A', pad: 5, suffix: '-X' });
  });
  it('returns null when there is no digit run', () => {
    expect(parseNoFormat('ABC')).toBeNull();
  });
});

describe('incrementNo', () => {
  it('returns startingNo when current is empty', () => {
    expect(incrementNo('', 1, 'NX000001')).toBe('NX000001');
  });
  it('increments preserving prefix and pad width', () => {
    expect(incrementNo('NX000005', 1, 'NX000001')).toBe('NX000006');
    expect(incrementNo('CHOC0041', 1, 'CHOC0001')).toBe('CHOC0042');
  });
  it('honors a custom increment', () => {
    expect(incrementNo('NX000010', 5, 'NX000001')).toBe('NX000015');
  });
  it('grows pad width when digits overflow', () => {
    expect(incrementNo('NX999999', 1, 'NX000001')).toBe('NX1000000');
  });
});

describe('compareNo', () => {
  it('compares numerically when prefixes match', () => {
    expect(compareNo('NX000010', 'NX000009')).toBe(1);
    expect(compareNo('NX000009', 'NX000010')).toBe(-1);
    expect(compareNo('NX000010', 'NX000010')).toBe(0);
  });
});

describe('isWithinRange', () => {
  it('accepts a candidate inside the range', () => {
    expect(isWithinRange('NX000500', 'NX000001', 'NX999999')).toBe(true);
  });
  it('rejects a candidate past the end', () => {
    expect(isWithinRange('NX1000000', 'NX000001', 'NX999999')).toBe(false);
  });
  it('rejects a different prefix (out of range)', () => {
    expect(isWithinRange('ZZ000001', 'NX000001', 'NX999999')).toBe(false);
  });
  it('treats a blank ending number as unlimited (BC)', () => {
    expect(isWithinRange('W01250', 'W00000', '')).toBe(true);
    expect(isWithinRange('ZZ01250', 'W00000', '')).toBe(false);
  });
});
