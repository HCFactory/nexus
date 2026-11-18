import { describe, expect, it, vi } from 'vitest';
import {
  CARD_SELECT_FIELDS,
  fillCustomerCardFields,
  fillCustomerCardFieldsInChunks,
  mapCardToCustomerColumns,
} from './customerCardFill';

const card = {
  No: 'W00010', Name: 'Acme', E_Mail: 'a@x.com', EMailCCHCABG: 'cc@x.com', Phone_No: '555',
  Payment_Terms_Code: '30 DAYS', Tax_Area_Code: 'HI-HNL-RT', Tax_Liable: true,
  Tax_Identification_Type: 'Legal Entity', Customer_Price_Group: 'WHSL-DLVRY',
  Customer_Posting_Group: 'DOMESTIC', Gen_Bus_Posting_Group: 'DOMESTIC', Application_Method: 'Manual',
  Location_Code: 'MAIN', Blocked: 'Invoice', Credit_Limit_LCY: 2500.5,
};

describe('mapCardToCustomerColumns', () => {
  it('fills every new column and the card etag', () => {
    expect(mapCardToCustomerColumns({ etag: 'W/"1"', fields: card })).toEqual({
      email_cc: 'cc@x.com', payment_terms_code: '30 DAYS', tax_area_code: 'HI-HNL-RT',
      tax_identification_type: 'Legal Entity', customer_price_group: 'WHSL-DLVRY',
      customer_posting_group: 'DOMESTIC', gen_bus_posting_group: 'DOMESTIC', application_method: 'Manual',
      location_code: 'MAIN', credit_limit: 2500.5, blocked: 'Invoice', bc_card_etag: 'W/"1"',
      contact_no: '', mobile_phone_no: '', ship_to_code: '', shipment_method_code: '',
    });
  });
  it('uses empty string / 0 for missing values', () => {
    const out = mapCardToCustomerColumns({ etag: 'e', fields: { No: 'X', Payment_Terms_Code: null } });
    expect(out.payment_terms_code).toBe('');
    expect(out.email_cc).toBe('');
    expect(out.credit_limit).toBe(0);
  });
});

describe('mapCardToCustomerColumns new fields', () => {
  it('fills contact, mobile, default ship-to and shipment method', () => {
    const out = mapCardToCustomerColumns({ etag: 'e', fields: {
      Primary_Contact_No: 'CT101830', MobilePhoneNo: '808', Ship_to_Code: '165KAIHOLU', Shipment_Method_Code: 'GROUND' } });
    expect(out).toMatchObject({ contact_no: 'CT101830', mobile_phone_no: '808', ship_to_code: '165KAIHOLU', shipment_method_code: 'GROUND' });
  });
});

describe('mapCardToCustomerColumns blocked', () => {
  it('sets blocked null for a blank space and for _x0020_', () => {
    expect(mapCardToCustomerColumns({ etag: 'e', fields: { No: 'X', Blocked: ' ' } }).blocked).toBeNull();
    expect(mapCardToCustomerColumns({ etag: 'e', fields: { No: 'X', Blocked: '_x0020_' } }).blocked).toBeNull();
    expect(mapCardToCustomerColumns({ etag: 'e', fields: { No: 'X' } }).blocked).toBeNull();
  });
  it('keeps Invoice', () => {
    expect(mapCardToCustomerColumns({ etag: 'e', fields: { No: 'X', Blocked: 'Invoice' } }).blocked).toBe('Invoice');
  });
});

describe('fillCustomerCardFields', () => {
  it('updates matched customers by number and counts them', async () => {
    const update = vi.fn(async () => {});
    const n = await fillCustomerCardFields(
      [{ key: { values: { No: 'W00010' } }, etag: 'e1', fields: card }],
      new Map([['W00010', null], ['W00011', null]]),
      update,
    );
    expect(n).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('W00010', expect.objectContaining({ bc_card_etag: 'e1', email_cc: 'cc@x.com' }));
  });
  it('skips cards with no matching customer row', async () => {
    const update = vi.fn(async () => {});
    const n = await fillCustomerCardFields(
      [{ key: { values: { No: 'ZZ' } }, etag: 'e', fields: { No: 'ZZ' } }], new Map([['A', null]]), update,
    );
    expect(n).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });
  it('skips a customer whose stored card etag matches BC', async () => {
    const update = vi.fn(async () => {});
    const n = await fillCustomerCardFields(
      [
        { key: { values: { No: 'W00010' } }, etag: 'e1', fields: card },
        { key: { values: { No: 'W00011' } }, etag: 'e2-new', fields: { ...card, No: 'W00011' } },
      ],
      new Map([['W00010', 'e1'], ['W00011', 'e2-old']]),
      update,
    );
    expect(n).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('W00011', expect.objectContaining({ bc_card_etag: 'e2-new' }));
  });
  it('fills a customer with no stored etag, and a card with no etag is never skipped', async () => {
    const update = vi.fn(async () => {});
    const n = await fillCustomerCardFields(
      [
        { key: { values: { No: 'A' } }, etag: 'e1', fields: card },
        { key: { values: { No: 'B' } }, etag: '', fields: card },
      ],
      new Map([['A', null], ['B', '']]),
      update,
    );
    expect(n).toBe(2);
  });
});

describe('CARD_SELECT_FIELDS', () => {
  it('asks BC for exactly the fields the fill reads (plus the key), no calculated fields', () => {
    const read = new Set<string>();
    const fields = new Proxy({} as Record<string, unknown>, {
      get: (_t, k) => {
        read.add(String(k));
        return undefined;
      },
    });
    mapCardToCustomerColumns({ etag: '', fields });
    expect(new Set(CARD_SELECT_FIELDS)).toEqual(new Set(['No', ...read]));
  });
});

describe('fillCustomerCardFieldsInChunks', () => {
  const rec = (no: string) => ({ key: { values: { No: no } }, etag: `e-${no}`, fields: { ...card, No: no } });
  const nums = (from: number, n: number) => Array.from({ length: n }, (_, i) => `C${String(from + i).padStart(4, '0')}`);

  function run(opts: { all: string[]; startAfter?: string | null; chunks?: number; fail?: (after: string | null) => boolean }) {
    const fetchChunk = vi.fn(async (after: string | null, size: number) => {
      if (opts.fail?.(after)) throw new Error('The operation was aborted due to timeout');
      return opts.all.filter((n) => after === null || n > after).slice(0, size).map(rec);
    });
    const update = vi.fn<(no: string, patch: Record<string, unknown>) => Promise<void>>(async () => {});
    let left = opts.chunks ?? Infinity;
    const hasTime = () => left-- > 0;
    const known = new Map(opts.all.map((n) => [n, null] as [string, null]));
    const done = fillCustomerCardFieldsInChunks({ fetchChunk, known, update, startAfter: opts.startAfter ?? null, hasTime, chunkSize: 3 });
    return { done, fetchChunk, update };
  }

  it('reads batch after batch from where the last one ended, then reports complete with no cursor', async () => {
    const { done, fetchChunk, update } = run({ all: nums(1, 7) });
    expect(await done).toEqual({ filled: 7, cursor: null, complete: true });
    expect(fetchChunk.mock.calls).toEqual([[null, 3], ['C0003', 3], ['C0006', 3]]);
    expect(update).toHaveBeenCalledTimes(7);
  });

  it('an exact multiple of the batch size ends with one empty batch, then complete', async () => {
    const { done, fetchChunk } = run({ all: nums(1, 6) });
    expect(await done).toMatchObject({ complete: true, cursor: null });
    expect(fetchChunk).toHaveBeenCalledTimes(3);
  });

  it('out of time: stops before the next batch and returns the last customer filled as the cursor', async () => {
    const { done, fetchChunk } = run({ all: nums(1, 7), chunks: 2 });
    expect(await done).toEqual({ filled: 6, cursor: 'C0006', complete: false });
    expect(fetchChunk).toHaveBeenCalledTimes(2);
  });

  it('continues after a saved cursor', async () => {
    const { done, fetchChunk } = run({ all: nums(1, 7), startAfter: 'C0006' });
    expect(await done).toEqual({ filled: 1, cursor: null, complete: true });
    expect(fetchChunk.mock.calls[0]).toEqual(['C0006', 3]);
  });

  it('a batch that fails keeps the progress so far and returns the error', async () => {
    const { done } = run({ all: nums(1, 7), fail: (after) => after === 'C0003' });
    expect(await done).toEqual({ filled: 3, cursor: 'C0003', complete: false, error: 'The operation was aborted due to timeout' });
  });

  it('a failed save keeps the cursor at the batch before it', async () => {
    const { done, update } = run({ all: nums(1, 7) });
    update.mockImplementation(async (no: string) => {
      if (no === 'C0005') throw new Error('db down');
    });
    expect(await done).toMatchObject({ cursor: 'C0003', complete: false, error: 'db down' });
  });

  it('no time at all: reads nothing and keeps the cursor it was given', async () => {
    const { done, fetchChunk } = run({ all: nums(1, 7), startAfter: 'C0003', chunks: 0 });
    expect(await done).toEqual({ filled: 0, cursor: 'C0003', complete: false });
    expect(fetchChunk).not.toHaveBeenCalled();
  });
});
