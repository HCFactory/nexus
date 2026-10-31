import type { FieldSpec } from '@/types/customerReferences';
import type { ListDefinition } from './listDefinition';
import type { BcRecord } from './transport';

export interface LocalRow { id: string; bcId: string | null; keyValues: Record<string, string>; values: Record<string, unknown>; etag: string | null }
export interface SyncPlan { inserts: BcRecord[]; updates: { id: string; record: BcRecord }[]; deletes: string[] }

function norm(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

export function changedFields(original: Record<string, unknown>, edited: Record<string, unknown>, fields: FieldSpec[]): string[] {
  return fields.filter((f) => norm(original[f.name]) !== norm(edited[f.name])).map((f) => f.name);
}

function keyString(parts: Record<string, string>, keyNames: string[]): string {
  return JSON.stringify(keyNames.map((n) => parts[n] ?? ''));
}

export function planSyncPull(def: ListDefinition, local: LocalRow[], remote: BcRecord[]): SyncPlan {
  const keyFields = def.fields.filter((f) => f.isKey);
  const keyNames = keyFields.map((f) => f.name);

  const remoteKey = (r: BcRecord): string => {
    const parts: Record<string, string> = {};
    for (const f of keyFields) parts[f.name] = norm(r.fields[f.bcName]);
    return keyString(parts, keyNames);
  };
  const localKey = (l: LocalRow): string => {
    const parts: Record<string, string> = {};
    for (const f of keyFields) parts[f.name] = norm(l.keyValues[f.name] ?? l.values[f.name]);
    return keyString(parts, keyNames);
  };

  const localByBcId = new Map<string, LocalRow>();
  const localByKey = new Map<string, LocalRow>();
  for (const l of local) {
    if (l.bcId) localByBcId.set(l.bcId, l);
    localByKey.set(localKey(l), l);
  }

  const matched = new Set<string>();
  const plan: SyncPlan = { inserts: [], updates: [], deletes: [] };

  for (const r of remote) {
    const remoteBcId = 'bcId' in r.key ? r.key.bcId : null;
    let l = remoteBcId ? localByBcId.get(remoteBcId) : undefined;
    if (!l) {
      const candidate = localByKey.get(remoteKey(r));
      // Only fall back to key match when it can't contradict a bcId on both sides.
      if (candidate && !(remoteBcId && candidate.bcId && candidate.bcId !== remoteBcId)) l = candidate;
    }
    if (!l || matched.has(l.id)) {
      plan.inserts.push(r);
      continue;
    }
    matched.add(l.id);
    const remoteValues: Record<string, unknown> = {};
    for (const f of def.fields) remoteValues[f.name] = r.fields[f.bcName];
    const differs = changedFields(l.values, remoteValues, def.fields).length > 0 || (l.etag ?? '') !== r.etag;
    if (differs) plan.updates.push({ id: l.id, record: r });
  }

  for (const l of local) if (!matched.has(l.id)) plan.deletes.push(l.id);
  return plan;
}
