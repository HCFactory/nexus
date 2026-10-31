import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FieldSpec, ReferenceEntry } from '@/types/customerReferences';
import { ReferenceEntryForm } from './ReferenceEntryForm';

const actions = vi.hoisted(() => ({ saveReferenceEntry: vi.fn() }));
vi.mock('@/app/actions/customerReferenceLists', () => actions);

const fields: FieldSpec[] = [
  { name: 'code', bcName: 'code', label: 'Code', type: 'text', required: true, isKey: true, editable: true, maxLength: 10 },
  { name: 'name', bcName: 'name', label: 'Name', type: 'text', editable: true, maxLength: 50 },
  { name: 'contact_type', bcName: 'contactType', label: 'Contact type', type: 'select', editable: true, options: [{ value: 'Company', label: 'Company' }, { value: 'Person', label: 'Person' }] },
  { name: 'no_series', bcName: 'noSeries', label: 'No. series', type: 'select', editable: true, optionsFrom: 'paymentTerms', optionsMatch: 'CUST' },
  { name: 'apply', bcName: 'apply', label: 'Apply method', type: 'select', editable: true, options: [{ value: 'Manual', label: 'Manual' }, { value: 'Apply to Oldest', label: 'Apply to Oldest' }], defaultValue: 'Manual' },
];

const selectOptions = {
  paymentTerms: [
    { code: 'CUST', label: 'CUST' },
    { code: 'fund-cust', label: 'fund-cust' },
    { code: 'ITEM', label: 'ITEM' },
  ],
};

function entry(values: Record<string, unknown>): ReferenceEntry {
  return { id: 'e1', values, bcLastModifiedAt: null, lastSyncedAt: null };
}

function renderForm(e: ReferenceEntry | null) {
  return render(
    <ReferenceEntryForm listKey="paymentTerms" fields={fields} entry={e} selectOptions={selectOptions} onDone={vi.fn()} onCancel={vi.fn()} />,
  );
}

const optionLabels = (label: RegExp) =>
  Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map((o) => o.textContent);

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('ReferenceEntryForm select options', () => {
  it('offers fixed options for a select with options', () => {
    renderForm(null);
    expect(optionLabels(/Contact type/)).toEqual(expect.arrayContaining(['Company', 'Person']));
  });

  it('filters optionsFrom options by optionsMatch, ignoring case', () => {
    renderForm(null);
    const labels = optionLabels(/No\. series/);
    expect(labels).toContain('CUST');
    expect(labels).toContain('fund-cust');
    expect(labels).not.toContain('ITEM');
  });

  it('keeps a current value that the options filter or fixed list would hide', async () => {
    const values = { code: 'C1', name: 'Acme', contact_type: 'Other', no_series: 'ITEM', apply: 'Manual' };
    renderForm(entry(values));
    expect((screen.getByLabelText(/No\. series/) as HTMLSelectElement).value).toBe('ITEM');
    expect((screen.getByLabelText(/Contact type/) as HTMLSelectElement).value).toBe('Other');
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Acme 2' } });
    fireEvent.click(screen.getByRole('button', { name: /review changes/i }));
    actions.saveReferenceEntry.mockResolvedValue({ ok: true, entry: {} });
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(actions.saveReferenceEntry).toHaveBeenCalled());
    const edited = actions.saveReferenceEntry.mock.calls[0][1].edited;
    expect(edited.no_series).toBe('ITEM');
    expect(edited.contact_type).toBe('Other');
    expect(edited.name).toBe('Acme 2');
  });

  it('pre-fills defaultValue on create only', () => {
    const { unmount } = renderForm(null);
    expect((screen.getByLabelText(/Apply method/) as HTMLSelectElement).value).toBe('Manual');
    unmount();
    renderForm(entry({ code: 'C1', apply: 'Apply to Oldest' }));
    expect((screen.getByLabelText(/Apply method/) as HTMLSelectElement).value).toBe('Apply to Oldest');
  });
});
