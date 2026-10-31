import { describe, expect, it } from 'vitest';
import { coerce, toBcFields, toDbValues } from './mapping';
import type { FieldSpec } from '@/types/customerReferences';
import type { ListDefinition } from './listDefinition';
import { LIST_DEFINITIONS } from './definitions';

const def = {
  key: 'paymentTerms', title: 'P', table: 't', mode: 'managed', source: { kind: 'api', resource: 'x' }, renameField: 'code',
  fields: [
    { name: 'code', bcName: 'code', label: 'Code', type: 'text', isKey: true, editable: true },
    { name: 'display_name', bcName: 'displayName', label: 'Description', type: 'text', editable: true },
  ],
} as unknown as ListDefinition;

describe('mapping', () => {
  it('maps BC fields to DB columns, ignoring unknown fields and defaulting missing text to empty string', () => {
    expect(toDbValues(def, { key: { bcId: '1' }, etag: 'e', fields: { code: 'A', extra: 1 } })).toEqual({ code: 'A', display_name: '' });
  });
  it('maps only supplied DB columns to BC fields', () => {
    expect(toBcFields(def, { display_name: 'Net 30' })).toEqual({ displayName: 'Net 30' });
  });
  it('sends empty string, not null, for a blank tax group on taxDetails create', () => {
    expect(toBcFields(LIST_DEFINITIONS.taxDetails, { tax_group_code: null, tax_jurisdiction_code: 'J' })).toMatchObject({
      Tax_Group_Code: '', Tax_Jurisdiction_Code: 'J',
    });
  });
  it('defaults missing numeric BC fields to 0', () => {
    const rec = { key: { bcId: '1' }, etag: 'e', fields: { Tax_Jurisdiction_Code: 'J' } } as never;
    expect(toDbValues(LIST_DEFINITIONS.taxDetails, rec)).toMatchObject({ tax_below_maximum: 0, maximum_amount_qty: 0, effective_date: null });
  });
  it('coerce is the single null rule shared with the change preview', () => {
    const spec = (type: FieldSpec['type']) => ({ name: 'x', bcName: 'X', label: 'X', type, editable: true }) as FieldSpec;
    expect(coerce(spec('percent'), null)).toBe(0);
    expect(coerce(spec('number'), undefined)).toBe(0);
    expect(coerce(spec('text'), null)).toBe('');
    expect(coerce(spec('boolean'), null)).toBe(false);
    expect(coerce(spec('date'), null)).toBeNull();
    expect(coerce(spec('percent'), 4.5)).toBe(4.5);
  });
});
