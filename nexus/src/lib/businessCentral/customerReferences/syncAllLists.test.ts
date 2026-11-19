import { describe, expect, it, vi } from 'vitest';

import { ALL_LISTS_ORDER, syncAllLists } from './syncAllLists';
import { LIST_DEFINITIONS } from './definitions';

describe('syncAllLists', () => {
  it('covers every list exactly once, with templates (which need number series) last', () => {
    expect([...ALL_LISTS_ORDER].sort()).toEqual(Object.keys(LIST_DEFINITIONS).sort());
    expect(ALL_LISTS_ORDER.indexOf('noSeries')).toBeLessThan(ALL_LISTS_ORDER.indexOf('customerTemplates'));
    expect(ALL_LISTS_ORDER.at(-1)).toBe('customerTemplates');
    expect(ALL_LISTS_ORDER.indexOf('taxAreas')).toBeLessThan(ALL_LISTS_ORDER.indexOf('taxAreaLines'));
  });

  it('syncs each list in order and reports one result per list', async () => {
    const sync = vi.fn<(d: unknown, def: { key: string }) => Promise<{ inserted: number; updated: number; deleted: number }>>(async () => ({ inserted: 1, updated: 2, deleted: 0 }));
    const results = await syncAllLists({} as never, sync as never);
    expect(sync.mock.calls.map((c) => c[1].key)).toEqual(ALL_LISTS_ORDER);
    expect(results[0]).toEqual({ entityType: 'Payment terms', recordsSynced: 3, complete: true, cursor: null, error: null });
  });

  it('one failing list is reported and the rest still sync', async () => {
    const sync = vi.fn(async (_d: unknown, def: { key: string }) => {
      if (def.key === 'taxDetails') throw new Error('Reference list is unavailable (HTTP 404)');
      return { inserted: 0, updated: 0, deleted: 0 };
    });
    const results = await syncAllLists({} as never, sync as never);
    expect(results).toHaveLength(ALL_LISTS_ORDER.length);
    expect(results.find((r) => r.entityType === 'Tax details')).toMatchObject({ complete: false, error: 'Reference list is unavailable (HTTP 404)' });
    expect(results.at(-1)).toMatchObject({ entityType: 'Customer templates', complete: true });
  });
});
