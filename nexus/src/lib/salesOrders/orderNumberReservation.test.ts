import { describe, expect, it, vi } from 'vitest';
import { NoSeriesConflictError, type BcNoSeriesLine, type NoSeriesClient } from '@/lib/businessCentral/noSeriesClient';
import type { BcRecord, ReferenceTransport } from '@/lib/businessCentral/customerReferences/transport';
import { findOrderSeries, requireManualNos, takeNextNumber } from './orderNumberReservation';

const rec = (fields: Record<string, unknown>): BcRecord => ({ key: { bcId: 'x' }, etag: 'e', fields });

function transportWith(list: ReferenceTransport['list']): ReferenceTransport {
  return { list: vi.fn(list), get: vi.fn(), create: vi.fn(), patch: vi.fn(), remove: vi.fn() } as unknown as ReferenceTransport;
}

const line = (extra: Partial<BcNoSeriesLine> = {}): BcNoSeriesLine => ({
  seriesCode: 'WHSL', lineNo: 10000, startingNo: 'W-100001', endingNo: '', lastNoUsed: 'W-100535',
  lastDateUsed: '2026-11-17', incrementByNo: 1, implementation: 'Normal', open: true, etag: 'E1', ...extra,
});

describe('findOrderSeries', () => {
  it("reads the series of the latest order by its number", async () => {
    const t = transportWith(async () => [rec({ id: 'x', numberSeries: 'WHSL' })]);
    expect(await findOrderSeries(t, 'W-100535')).toBe('WHSL');
    const [source, opts] = vi.mocked(t.list).mock.calls[0];
    expect((source as { service: string }).service).toBe('salesDocuments');
    expect(opts?.filter).toBe("documentType eq 'Order' and number eq 'W-100535'");
  });

  it('with no Nexus order yet, takes the first series found on BC orders', async () => {
    const t = transportWith(async () => [rec({ id: 'a', numberSeries: '' }), rec({ id: 'b', numberSeries: 'WHSL' })]);
    expect(await findOrderSeries(t, null)).toBe('WHSL');
    expect(vi.mocked(t.list).mock.calls[0][1]?.filter).toBe("documentType eq 'Order'");
  });

  it('a latest number BC no longer has falls back to any order', async () => {
    const list = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([rec({ id: 'b', numberSeries: 'WHSL' })]);
    expect(await findOrderSeries(transportWith(list), 'W-1')).toBe('WHSL');
  });

  it('no series anywhere is an error', async () => {
    await expect(findOrderSeries(transportWith(async () => []), null)).rejects.toThrow(
      "Couldn't tell which number series BC uses for sales orders.",
    );
  });
});

describe('requireManualNos', () => {
  it('passes when Manual Nos. is on', async () => {
    const t = transportWith(async () => [rec({ Code: 'WHSL', Manual_Nos: true })]);
    await expect(requireManualNos(t, 'WHSL')).resolves.toBeUndefined();
    expect(vi.mocked(t.list).mock.calls[0][1]?.filter).toBe("Code eq 'WHSL'");
  });

  it('refuses when Manual Nos. is off or the series is missing', async () => {
    const msg = 'Turn on Manual Nos. for number series WHSL in Business Central to give new orders their number up front.';
    await expect(requireManualNos(transportWith(async () => [rec({ Code: 'WHSL', Manual_Nos: false })]), 'WHSL')).rejects.toThrow(msg);
    await expect(requireManualNos(transportWith(async () => []), 'WHSL')).rejects.toThrow(msg);
  });
});

describe('takeNextNumber', () => {
  function client(lines: BcNoSeriesLine[], advance: NoSeriesClient['advanceLine']): NoSeriesClient {
    const get = vi.fn();
    for (const l of lines) get.mockResolvedValueOnce(l);
    return { getOpenLine: get, advanceLine: vi.fn(advance) };
  }

  it('moves Last No. Used forward by one and returns that number', async () => {
    const c = client([line()], async (l) => l);
    expect(await takeNextNumber(c, 'WHSL', '2026-11-17')).toBe('W-100536');
    expect(c.advanceLine).toHaveBeenCalledWith(expect.objectContaining({ etag: 'E1' }), 'W-100536', '2026-11-17');
  });

  it('a clash re-reads and takes the next one', async () => {
    const advance = vi.fn().mockRejectedValueOnce(new NoSeriesConflictError()).mockImplementation(async (l: BcNoSeriesLine) => l);
    const c = client([line(), line({ lastNoUsed: 'W-100536', etag: 'E2' })], advance);
    expect(await takeNextNumber(c, 'WHSL', '2026-11-17')).toBe('W-100537');
    expect(advance).toHaveBeenLastCalledWith(expect.objectContaining({ etag: 'E2' }), 'W-100537', '2026-11-17');
  });

  it('gives up after 5 clashes', async () => {
    const c = client([line(), line(), line(), line(), line()], async () => { throw new NoSeriesConflictError(); });
    await expect(takeNextNumber(c, 'WHSL', '2026-11-17')).rejects.toBeInstanceOf(NoSeriesConflictError);
    expect(c.advanceLine).toHaveBeenCalledTimes(5);
  });

  it('refuses a missing line or a used-up range without touching BC', async () => {
    const none = client([], async (l) => l);
    vi.mocked(none.getOpenLine).mockResolvedValue(null);
    await expect(takeNextNumber(none, 'WHSL', '2026-11-17')).rejects.toThrow("No. Series 'WHSL' has no line in BC");
    const full = client([line({ endingNo: 'W-100535' })], async (l) => l);
    await expect(takeNextNumber(full, 'WHSL', '2026-11-17')).rejects.toThrow("No. Series 'WHSL' has no numbers left");
    expect(full.advanceLine).not.toHaveBeenCalled();
  });
});
