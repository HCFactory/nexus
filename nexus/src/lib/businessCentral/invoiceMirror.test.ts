import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAndMirrorSalesInvoice, mirrorSalesInvoice, mirrorSalesInvoiceLines, type InvoiceMirrorDeps } from './invoiceMirror';

type Upsert = { table: string; rows: Record<string, unknown> | Record<string, unknown>[]; onConflict?: string };

function stubSupabase() {
  const upserts: Upsert[] = [];
  const supabase = {
    from: (table: string) => ({
      upsert: (rows: Upsert["rows"], opts?: { onConflict?: string }) => {
        upserts.push({ table, rows, onConflict: opts?.onConflict });
        const all = { data: rows, error: null };
        return {
          select: () => ({
            single: async () => ({ data: Array.isArray(rows) ? rows[0] : rows, error: null }),
            then: (res: (v: typeof all) => unknown) => Promise.resolve(all).then(res),
          }),
        };
      },
    }),
  } as unknown as SupabaseClient;
  return { supabase, upserts };
}

const INVOICE = {
  id: 'g-1',
  number: 'INV-100412',
  externalDocumentNumber: 'W-100532',
  status: 'Open',
  totalAmountIncludingTax: 45.23,
};
const LINE = (id: string) => ({ id, documentId: 'g-1', sequence: 10000, lineObjectNumber: 'P-1001', quantity: 10, unitPrice: 4.5 });

function deps(listResourcePage: InvoiceMirrorDeps['listResourcePage']) {
  const { supabase, upserts } = stubSupabase();
  const d: InvoiceMirrorDeps = {
    supabase,
    listResourcePage,
    orgId: 'org-1',
    connectionId: 'conn-1',
    environment: 'TEST',
    companyId: 'co-1',
    now: () => '2026-11-15T00:00:00.000Z',
  };
  return { d, upserts };
}

describe('mirrorSalesInvoice', () => {
  it('upserts the mapped row with the Receivables conflict target and returns the stored row', async () => {
    const { d, upserts } = deps(vi.fn());
    expect((await mirrorSalesInvoice(d, INVOICE)).bc_invoice_id).toBe('g-1');
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      table: 'business_central_sales_invoices',
      onConflict: 'organization_id,bc_connection_id,bc_company_id,bc_invoice_id',
      rows: { organization_id: 'org-1', bc_connection_id: 'conn-1', bc_invoice_id: 'g-1', external_document_number: 'W-100532' },
    });
  });
});

describe('mirrorSalesInvoiceLines', () => {
  it('reads lines by documentId and upserts each mapped line; returns the stored rows', async () => {
    const list = vi.fn(async () => [LINE('l1'), LINE('l2')]) as unknown as InvoiceMirrorDeps['listResourcePage'];
    const { d, upserts } = deps(list);
    expect((await mirrorSalesInvoiceLines(d, 'g-1')).map((r) => r.bc_line_id)).toEqual(['l1', 'l2']);
    expect(list).toHaveBeenCalledWith('salesInvoiceLines', { filter: 'documentId eq g-1', top: 500 });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].table).toBe('business_central_sales_invoice_lines');
    expect(upserts[0].onConflict).toBe('organization_id,bc_connection_id,bc_company_id,bc_line_id');
    expect((upserts[0].rows as Record<string, unknown>[]).map((r) => r.bc_line_id)).toEqual(['l1', 'l2']);
  });

  it('with no lines writes nothing and returns []', async () => {
    const { d, upserts } = deps(vi.fn(async () => []) as unknown as InvoiceMirrorDeps['listResourcePage']);
    expect(await mirrorSalesInvoiceLines(d, 'g-1')).toEqual([]);
    expect(upserts).toHaveLength(0);
  });
});

describe('fetchAndMirrorSalesInvoice', () => {
  it('returns null for an unknown id and for a Draft; stores and returns the row for a posted one', async () => {
    const byId: Record<string, unknown[]> = { 'g-1': [INVOICE], 'g-draft': [{ ...INVOICE, id: 'g-draft', status: 'Draft' }] };
    const list = vi.fn(async (_r: string, o: { filter?: string }) => byId[o.filter!.replace('id eq ', '')] ?? []);
    const { d, upserts } = deps(list as unknown as InvoiceMirrorDeps['listResourcePage']);
    expect(await fetchAndMirrorSalesInvoice(d, 'g-404')).toBeNull();
    expect(await fetchAndMirrorSalesInvoice(d, 'g-draft')).toBeNull();
    expect(upserts).toHaveLength(0);
    expect((await fetchAndMirrorSalesInvoice(d, 'g-1'))?.bc_invoice_id).toBe('g-1');
    expect(list).toHaveBeenLastCalledWith('salesInvoices', { filter: 'id eq g-1', top: 1 });
    expect(upserts).toHaveLength(1);
  });
});
