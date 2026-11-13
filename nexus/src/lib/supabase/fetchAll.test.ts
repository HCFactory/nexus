import { describe, expect, it } from 'vitest';
import { fetchAll } from './fetchAll';

/** A query builder over an in-memory array that honours .range(a, b). */
const query = (rows: number[], error: unknown = null) => () => ({
  range: async (a: number, b: number) => ({ data: error ? null : rows.slice(a, b + 1), error }),
});

describe('fetchAll', () => {
  it('reads past the page size until a short page', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => i);
    expect(await fetchAll<number>(query(rows), 1000)).toEqual(rows);
  });

  it('reads an exact multiple of the page size (one empty page at the end)', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => i);
    expect(await fetchAll<number>(query(rows), 1000)).toHaveLength(2000);
  });

  it('names what it was reading in the error', async () => {
    await expect(fetchAll(query([], { message: 'boom' }), 1000, 'ledger entries')).rejects.toThrow(
      'Could not read ledger entries: boom',
    );
  });
});
