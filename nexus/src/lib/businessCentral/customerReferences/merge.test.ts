import { describe, expect, it } from 'vitest';
import { changedFields, planSyncPull, type LocalRow } from './merge';
import type { ListDefinition } from './listDefinition';
import type { FieldSpec } from '@/types/customerReferences';
import type { BcRecord } from './transport';

const fields: FieldSpec[] = [
  { name: 'code', bcName: 'code', label: 'Code', type: 'text', isKey: true, required: true, editable: true, maxLength: 10 },
  { name: 'display_name', bcName: 'displayName', label: 'Description', type: 'text', editable: true },
];
const def = { key: 'paymentTerms', title: 'Payment Terms', table: 't', mode: 'managed', source: { kind: 'api', entity: 'x' }, fields, renameField: 'code' } as unknown as ListDefinition;

const local = (o: Partial<LocalRow> & { code: string; name?: string }): LocalRow => ({
  id: o.id ?? 'L-' + o.code, bcId: o.bcId ?? null, keyValues: { code: o.code },
  values: { code: o.code, display_name: o.name ?? '' }, etag: o.etag ?? 'e1',
});
const remote = (code: string, name: string, o: { bcId?: string; etag?: string } = {}): BcRecord => ({
  key: o.bcId ? { bcId: o.bcId } : { values: { code } }, etag: o.etag ?? 'e1', fields: { code, displayName: name },
});

describe('changedFields', () => {
  it('ignores untouched fields', () => {
    expect(changedFields({ code: 'A', display_name: 'x' }, { code: 'A', display_name: 'y' }, fields)).toEqual(['display_name']);
  });
  it("treats '' and null as equal", () => {
    expect(changedFields({ code: 'A', display_name: null }, { code: 'A', display_name: '' }, fields)).toEqual([]);
  });
});

describe('planSyncPull', () => {
  it('new remote -> insert', () => {
    const r = remote('A', 'a');
    expect(planSyncPull(def, [], [r])).toEqual({ inserts: [r], updates: [], deletes: [] });
  });
  it('missing remote -> delete', () => {
    expect(planSyncPull(def, [local({ code: 'A', id: 'L1' })], [])).toEqual({ inserts: [], updates: [], deletes: ['L1'] });
  });
  it('different -> update', () => {
    const r = remote('A', 'new');
    expect(planSyncPull(def, [local({ code: 'A', name: 'old', id: 'L1' })], [r])).toEqual({ inserts: [], updates: [{ id: 'L1', record: r }], deletes: [] });
  });
  it('etag-only difference -> update', () => {
    const r = remote('A', 'a', { etag: 'e2' });
    expect(planSyncPull(def, [local({ code: 'A', name: 'a', id: 'L1' })], [r]).updates).toHaveLength(1);
  });
  it('identical -> nothing', () => {
    expect(planSyncPull(def, [local({ code: 'A', name: 'a' })], [remote('A', 'a')])).toEqual({ inserts: [], updates: [], deletes: [] });
  });
  it('matches renamed API row by bcId', () => {
    const r = remote('NEW', 'a', { bcId: 'A' });
    const plan = planSyncPull(def, [local({ code: 'OLD', bcId: 'A', name: 'a', id: 'L1' })], [r]);
    expect(plan.updates).toEqual([{ id: 'L1', record: r }]);
    expect(plan.inserts).toEqual([]);
    expect(plan.deletes).toEqual([]);
  });
});
