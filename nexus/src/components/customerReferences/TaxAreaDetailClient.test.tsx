import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FieldSpec, ListPageData, ReferenceEntry } from '@/types/customerReferences';
import { TaxAreaDetailClient } from './TaxAreaDetailClient';

const refresh = vi.fn();
const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, replace }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

const actions = vi.hoisted(() => ({
  saveReferenceEntry: vi.fn(),
  deleteReferenceEntry: vi.fn(),
  syncReferenceList: vi.fn(),
}));
vi.mock('@/app/actions/customerReferenceLists', () => actions);

const areaFields: FieldSpec[] = [
  { name: 'code', bcName: 'code', label: 'Code', type: 'text', required: true, isKey: true, editable: true, maxLength: 20 },
  { name: 'display_name', bcName: 'displayName', label: 'Description', type: 'text', editable: true, maxLength: 100 },
];
const lineFields: FieldSpec[] = [
  { name: 'tax_area_code', bcName: 'Tax_Area', label: 'Tax area', type: 'text', required: true, isKey: true, editable: true, maxLength: 20 },
  { name: 'tax_jurisdiction_code', bcName: 'J', label: 'Tax jurisdiction', type: 'select', required: true, isKey: true, editable: true, optionsFrom: 'taxJurisdictions' },
  { name: 'calculation_order', bcName: 'C', label: 'Calculation order', type: 'number', editable: true },
];

const area: ReferenceEntry = { id: 'a1', values: { code: 'TX/1', display_name: 'Texas' }, bcLastModifiedAt: null, lastSyncedAt: null };

function areaData(canManage = true): ListPageData {
  return { key: 'taxAreas', title: 'Tax areas', mode: 'managed', fields: areaFields, entries: [area], canManage, deleteDisabledReason: null };
}
function linesData(entries: ReferenceEntry[] = []): ListPageData {
  return { key: 'taxAreaLines', title: 'Tax area lines', mode: 'managed', fields: lineFields, entries, canManage: true, deleteDisabledReason: null };
}
const opts = { taxJurisdictions: [{ code: 'CITY', label: 'CITY — City' }] };

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('TaxAreaDetailClient', () => {
  it('zero lines shows the no-jurisdictions warning', () => {
    render(<TaxAreaDetailClient area={area} areaData={areaData()} linesData={linesData()} selectOptions={opts} />);
    expect(screen.getByText('This tax area has no jurisdictions, so it calculates no tax.')).toBeInTheDocument();
  });

  it('adding a line pre-fills tax_area_code', async () => {
    actions.saveReferenceEntry.mockResolvedValue({ ok: true, entry: {} });
    render(<TaxAreaDetailClient area={area} areaData={areaData()} linesData={linesData()} selectOptions={opts} />);
    fireEvent.click(screen.getByRole('button', { name: /^add/i }));
    expect(screen.queryByLabelText(/Tax area/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Tax jurisdiction/), { target: { value: 'CITY' } });
    fireEvent.click(screen.getByRole('button', { name: /review changes/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(actions.saveReferenceEntry).toHaveBeenCalledWith('taxAreaLines', {
      id: null,
      original: null,
      edited: { tax_area_code: 'TX/1', tax_jurisdiction_code: 'CITY', calculation_order: null },
    }));
  });

  it('links each line to its tax rates', () => {
    const line: ReferenceEntry = { id: 'l1', values: { tax_area_code: 'TX/1', tax_jurisdiction_code: 'CITY/X', calculation_order: 1 }, bcLastModifiedAt: null, lastSyncedAt: null };
    render(<TaxAreaDetailClient area={area} areaData={areaData()} linesData={linesData([line])} selectOptions={opts} />);
    expect(screen.getByRole('link', { name: 'Tax rates' })).toHaveAttribute('href', '/customer-lists/taxDetails?jurisdiction=CITY%2FX');
    expect(screen.queryByText('This tax area has no jurisdictions, so it calculates no tax.')).toBeNull();
  });

  it('rename navigates to the new code URL', async () => {
    actions.saveReferenceEntry.mockResolvedValue({ ok: true, entry: {} });
    render(<TaxAreaDetailClient area={area} areaData={areaData()} linesData={linesData()} selectOptions={opts} />);
    fireEvent.click(screen.getByRole('button', { name: /edit area/i }));
    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: 'TX/2' } });
    fireEvent.click(screen.getByRole('button', { name: /review changes/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/customer-lists/tax-areas/TX%2F2'));
  });

  it('non-admin sees no edit controls', () => {
    render(<TaxAreaDetailClient area={area} areaData={areaData(false)} linesData={linesData()} selectOptions={opts} />);
    expect(screen.queryByRole('button', { name: /edit area/i })).toBeNull();
  });
});
