import { LIST_DEFINITIONS } from '@/lib/businessCentral/customerReferences/definitions';
import type { ReferenceTransport } from '@/lib/businessCentral/customerReferences/transport';
import { NoSeriesConflictError, type NoSeriesClient } from '@/lib/businessCentral/noSeriesClient';
import { SeriesExhaustedError, SeriesNotFoundError } from '@/lib/businessCentral/numberAssigner';
import { incrementNo, isWithinRange } from '@/lib/businessCentral/numberSeries';
import { SALES_DOCUMENT_SOURCE } from './bcOrderMapping';

const MAX_TRIES = 5;
const quote = (v: string) => `'${v.replace(/'/g, "''")}'`;

/**
 * The number series BC uses for sales orders: the one on the latest order
 * (by its number), else the first series on any BC order.
 */
export async function findOrderSeries(transport: ReferenceTransport, latestOrderNumber: string | null): Promise<string> {
  const select = ['id', 'numberSeries'];
  const seriesOf = (rows: { fields: Record<string, unknown> }[]) =>
    rows.map((r) => String(r.fields.numberSeries ?? '')).find((s) => s !== '') ?? null;
  if (latestOrderNumber) {
    const rows = await transport.list(SALES_DOCUMENT_SOURCE, {
      filter: `documentType eq 'Order' and number eq ${quote(latestOrderNumber)}`,
      select,
    });
    const found = seriesOf(rows);
    if (found) return found;
  }
  const found = seriesOf(await transport.list(SALES_DOCUMENT_SOURCE, { filter: "documentType eq 'Order'", select }));
  if (!found) throw new Error("Couldn't tell which number series BC uses for sales orders.");
  return found;
}

/** BC only accepts an order created with its own number when the series allows manual numbers. */
export async function requireManualNos(transport: ReferenceTransport, seriesCode: string): Promise<void> {
  const rows = await transport.list(LIST_DEFINITIONS.noSeries.source, {
    filter: `Code eq ${quote(seriesCode)}`,
    select: ['Code', 'Manual_Nos'],
  });
  if (rows[0]?.fields.Manual_Nos !== true) {
    throw new Error(
      `Turn on Manual Nos. for number series ${seriesCode} in Business Central to give new orders their number up front.`,
    );
  }
}

/**
 * Takes the series' next number: moves Last No. Used forward by one, guarded
 * by the line's etag. A clash (someone else took a number) re-reads the line
 * and tries the number after theirs, so two callers never get the same one.
 */
export async function takeNextNumber(noSeries: NoSeriesClient, seriesCode: string, today: string): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const line = await noSeries.getOpenLine(seriesCode);
    if (!line) throw new SeriesNotFoundError(seriesCode);
    const candidate = incrementNo(line.lastNoUsed, line.incrementByNo, line.startingNo);
    if (!isWithinRange(candidate, line.startingNo, line.endingNo)) throw new SeriesExhaustedError(seriesCode);
    try {
      await noSeries.advanceLine(line, candidate, today);
      return candidate;
    } catch (e) {
      if (!(e instanceof NoSeriesConflictError) || attempt >= MAX_TRIES) throw e;
    }
  }
}
