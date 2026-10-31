export type ListKey = 'paymentTerms' | 'customerPriceGroups' | 'taxAreas' | 'taxAreaLines'
  | 'taxJurisdictions' | 'taxDetails' | 'locations' | 'customerPostingGroups' | 'generalBusinessPostingGroups';
export type FieldType = 'text' | 'dateFormula' | 'percent' | 'number' | 'boolean' | 'date' | 'select';
export interface FieldSpec {
  name: string;            // Nexus/DB column, snake_case
  bcName: string;          // BC field name (API camelCase or OData Field_Name)
  label: string;
  type: FieldType;
  required?: boolean;
  isKey?: boolean;         // part of the BC key
  editable: boolean;       // false for read-only lists
  maxLength?: number;      // e.g. 10 or 20 for BC Code fields
  optionsFrom?: ListKey | 'taxGroups';  // for 'select'
}
export interface ReferenceEntry { id: string; values: Record<string, unknown>; bcLastModifiedAt: string | null; lastSyncedAt: string | null }
export interface ListPageData { key: ListKey; title: string; mode: 'managed' | 'readOnly'; fields: FieldSpec[]; entries: ReferenceEntry[]; canManage: boolean; deleteDisabledReason: string | null }
