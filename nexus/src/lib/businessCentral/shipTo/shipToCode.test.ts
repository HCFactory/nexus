import { describe, expect, it } from 'vitest';
import { makeShipToCode } from './shipToCode';

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `165KAIHO-${from + i}`);

describe('makeShipToCode', () => {
  it('builds an uppercase code from the street, stripping non-alphanumerics', () => {
    expect(makeShipToCode('165 Kaiholu St', new Set())).toBe('165KAIHOLU');
    expect(makeShipToCode('99 dock rd.', new Set())).toBe('99DOCKRD');
  });

  it('appends a numeric suffix when the base is taken', () => {
    expect(makeShipToCode('165 Kaiholu St', new Set(['165KAIHOLU']))).toBe('165KAIHO-2');
  });

  it('keeps the total length at 10 when the suffix grows', () => {
    const taken = new Set(['165KAIHOLU', ...range(2, 9)]);
    expect(makeShipToCode('165 Kaiholu St', taken)).toBe('165KAIH-10');
  });

  it('falls back to SHIPTO when the street has no usable characters', () => {
    expect(makeShipToCode('', new Set())).toBe('SHIPTO');
    expect(makeShipToCode('', new Set(['SHIPTO']))).toBe('SHIPTO-2');
  });

  it('compares taken codes case-insensitively', () => {
    expect(makeShipToCode('165 Kaiholu St', new Set(['165kaiholu']))).toBe('165KAIHO-2');
  });

  it('always returns at most 10 uppercase characters', () => {
    const samples = ['165 Kaiholu St', '99 dock rd.', '', '1234567890123 Very Long Street Name', '#$%'];
    for (const street of samples) {
      const code = makeShipToCode(street, new Set());
      expect(code.length).toBeLessThanOrEqual(10);
      expect(code).toBe(code.toUpperCase());
    }
  });
});
