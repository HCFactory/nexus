import type { FieldSpec } from '@/types/customerReferences';
import type { ListDefinition } from './listDefinition';
import type { BcRecord } from './transport';

/** BC fields are never null: coerce by type. Dates stay null. */
function coerce(f: FieldSpec, v: unknown): unknown {
  if (v !== null && v !== undefined) return v;
  switch (f.type) {
    case 'text': case 'select': case 'dateFormula': return '';
    case 'number': case 'percent': return 0;
    case 'boolean': return false;
    default: return null;
  }
}

/** BC record fields (keyed by bcName) to DB column values (keyed by FieldSpec name). */
export function toDbValues(def: ListDefinition, record: BcRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of def.fields) out[f.name] = coerce(f, record.fields[f.bcName]);
  return out;
}

/** DB column values to BC fields. Only fields present in `values` are emitted. */
export function toBcFields(def: ListDefinition, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of def.fields) {
    if (Object.prototype.hasOwnProperty.call(values, f.name) && values[f.name] !== undefined) {
      out[f.bcName] = coerce(f, values[f.name]);
    }
  }
  return out;
}
