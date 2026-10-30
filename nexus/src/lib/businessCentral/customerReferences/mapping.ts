import type { ListDefinition } from './listDefinition';
import type { BcRecord } from './transport';

/** BC record fields (keyed by bcName) to DB column values (keyed by FieldSpec name). */
export function toDbValues(def: ListDefinition, record: BcRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of def.fields) out[f.name] = record.fields[f.bcName] ?? null;
  return out;
}

/** DB column values to BC fields. Only fields present in `values` are emitted. */
export function toBcFields(def: ListDefinition, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of def.fields) {
    if (Object.prototype.hasOwnProperty.call(values, f.name) && values[f.name] !== undefined) {
      out[f.bcName] = values[f.name];
    }
  }
  return out;
}
