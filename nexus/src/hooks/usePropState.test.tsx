import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePropState } from './usePropState';

describe('usePropState', () => {
  it('starts from the prop, keeps local edits, and resets when the prop changes', () => {
    const { result, rerender } = renderHook(({ value }) => usePropState(value), { initialProps: { value: 1 } });
    expect(result.current[0]).toBe(1);

    act(() => result.current[1](5));
    expect(result.current[0]).toBe(5);

    rerender({ value: 1 }); // same prop: the local edit stays
    expect(result.current[0]).toBe(5);

    rerender({ value: 2 }); // new prop: reset
    expect(result.current[0]).toBe(2);
  });

  it('maps the prop with toState', () => {
    const { result, rerender } = renderHook(({ value }) => usePropState(value, (v: number | null) => (v == null ? '' : `#${v}`)), {
      initialProps: { value: null as number | null },
    });
    expect(result.current[0]).toBe('');
    rerender({ value: 7 });
    expect(result.current[0]).toBe('#7');
  });

  it('resets for a new array even with equal contents (reference change)', () => {
    const a = [1];
    const { result, rerender } = renderHook(({ list }) => usePropState(list), { initialProps: { list: a } });
    act(() => result.current[1]([9]));
    rerender({ list: [1] });
    expect(result.current[0]).toEqual([1]);
  });
});
