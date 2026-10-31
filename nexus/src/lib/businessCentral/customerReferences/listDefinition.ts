import type { FieldSpec, ListKey } from '@/types/customerReferences';
import type { ReferenceSource } from './transport';

export interface ListDefinition {
  key: ListKey; title: string; table: string; mode: 'managed' | 'readOnly';
  source: ReferenceSource; fields: FieldSpec[];
  renameField: string | null;          // 'code' for code lists; null for lines/details
  parent?: { list: ListKey; field: string };
  deleteDisabledReason?: string;
}
