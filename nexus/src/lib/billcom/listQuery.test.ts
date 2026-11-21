import { describe, expect, it } from 'vitest';

import { billcomListQuery } from './listQuery';

describe('billcomListQuery', () => {
  it('first page: filters, sort and max as given', () => {
    const qs = new URLSearchParams(billcomListQuery({ filters: 'updatedTime:gte:"2026-11-20T00:00:00.000Z"', sort: 'updatedTime:asc', max: '100' }));
    expect(Object.fromEntries(qs)).toEqual({ filters: 'updatedTime:gte:"2026-11-20T00:00:00.000Z"', sort: 'updatedTime:asc', max: '100' });
  });

  it('later pages: only the page token and max (Bill.com refuses sort and filters with page)', () => {
    const qs = new URLSearchParams(billcomListQuery({ filters: 'customerId:eq:0cu1', sort: 'updatedTime:asc', max: '100' }, 'tok-2'));
    expect(Object.fromEntries(qs)).toEqual({ page: 'tok-2', max: '100' });
  });

  it('leaves out empty values', () => {
    expect(billcomListQuery({ filters: undefined, max: '100' })).toBe('max=100');
  });
});
