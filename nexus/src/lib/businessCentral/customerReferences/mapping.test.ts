import { describe, expect, it } from 'vitest';
import { toBcFields, toDbValues } from './mapping';
import type { ListDefinition } from './listDefinition';

const def = {
  key: 'paymentTerms', title: 'P', table: 't', mode: 'managed', source: { kind: 'api', resource: 'x' }, renameField: 'code',
  fields: [
    { name: 'code', bcName: 'code', label: 'Code', type: 'text', isKey: true, editable: true },
    { name: 'display_name', bcName: 'displayName', label: 'Description', type: 'text', editable: true },
  ],
} as unknown as ListDefinition;

describe('mapping', () => {
  it('maps BC fields to DB columns, ignoring unknown fields and nulling missing', () => {
    expect(toDbValues(def, { key: { bcId: '1' }, etag: 'e', fields: { code: 'A', extra: 1 } })).toEqual({ code: 'A', display_name: null });
  });
  it('maps only supplied DB columns to BC fields', () => {
    expect(toBcFields(def, { display_name: 'Net 30' })).toEqual({ displayName: 'Net 30' });
  });
});
