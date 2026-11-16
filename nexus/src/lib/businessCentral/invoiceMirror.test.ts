import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAndMirrorSalesInvoice, mirrorSalesInvoice, mirrorSalesInvoiceLines, type InvoiceMirrorDeps } from './invoiceMirror';

type Upsert = { table: string; rows: Record<string, unknown> | Record<string, unknown>[]; onConflict?: string };

function stubSupabase() {
  const upserts: Upsert[] = [];
  const supabase = {
    from: (table: string) => ({
      upsert: async (rows: Upsert['rows'], opts?: { onConflict?: string }) => {
        upserts.push({ table, rows, onConflict: opts?.onConflict });
        return { error: null };
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
  it('upserts the mapped row with the Receivables conflict target', async () => {
    const { d, upserts } = deps(vi.fn());
    await mirrorSalesInvoice(d, INVOICE);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      table: 'business_central_sales_invoices',
      onConflict: 'organization_id,bc_connection_id,bc_company_id,bc_invoice_id',
      rows: { organization_id: 'org-1', bc_connection_id: 'conn-1', bc_invoice_id: 'g-1', external_document_number: 'W-100532' },
    });
  });
});

describe('mirrorSalesInvoiceLines', () => {
  it('reads lines by documentId and upserts each mapped line; returns the count', async () => {
    const list = vi.fn(async () => [LINE('l1'), LINE('l2')]) as unknown as InvoiceMirrorDeps['listResourcePage'];
    const { d, upserts } = deps(list);
    expect(await mirrorSalesInvoiceLines(d, 'g-1')).toBe(2);
    expect(list).toHaveBeenCalledWith('salesInvoiceLines', { filter: 'documentId eq g-1', top: 500 });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].table).toBe('business_central_sales_invoice_lines');
    expect(upserts[0].onConflict).toBe('organization_id,bc_connection_id,bc_company_id,bc_line_id');
    expect((upserts[0].rows as Record<string, unknown>[]).map((r) => r.bc_line_id)).toEqual(['l1', 'l2']);
  });

  it('with no lines writes nothing and returns 0', async () => {
    const { d, upserts } = deps(vi.fn(async () => []) as unknown as InvoiceMirrorDeps['listResourcePage']);
    expect(await mirrorSalesInvoiceLines(d, 'g-1')).toBe(0);
    expect(upserts).toHaveLength(0);
  });
});

describe('fetchAndMirrorSalesInvoice', () => {
  it('returns false for an unknown id and for a Draft, true and stores the row for a posted one', async () => {
    const byId: Record<string, unknown[]> = { 'g-1': [INVOICE], 'g-draft': [{ ...INVOICE, id: 'g-draft', status: 'Draft' }] };
    const list = vi.fn(async (_r: string, o: { filter?: string }) => byId[o.filter!.replace('id eq ', '')] ?? []);
    const { d, upserts } = deps(list as unknown as InvoiceMirrorDeps['listResourcePage']);
    expect(await fetchAndMirrorSalesInvoice(d, 'g-404')).toBe(false);
    expect(await fetchAndMirrorSalesInvoice(d, 'g-draft')).toBe(false);
    expect(upserts).toHaveLength(0);
    expect(await fetchAndMirrorSalesInvoice(d, 'g-1')).toBe(true);
    expect(list).toHaveBeenLastCalledWith('salesInvoices', { filter: 'id eq g-1', top: 1 });
    expect(upserts).toHaveLength(1);
  });
});
