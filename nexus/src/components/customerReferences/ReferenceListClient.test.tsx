import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FieldSpec, ListPageData } from '@/types/customerReferences';
import { ReferenceListClient } from './ReferenceListClient';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const actions = vi.hoisted(() => ({
  saveReferenceEntry: vi.fn(),
  deleteReferenceEntry: vi.fn(),
  syncReferenceList: vi.fn(),
}));
vi.mock('@/app/actions/customerReferenceLists', () => actions);

const termFields: FieldSpec[] = [
  { name: 'code', bcName: 'code', label: 'Code', type: 'text', required: true, isKey: true, editable: true, maxLength: 10 },
  { name: 'display_name', bcName: 'displayName', label: 'Description', type: 'text', editable: true, maxLength: 100 },
  { name: 'discount_percent', bcName: 'discountPercent', label: 'Discount %', type: 'percent', editable: true },
];

function page(over: Partial<ListPageData> = {}): ListPageData {
  return {
    key: 'paymentTerms',
    title: 'Payment terms',
    mode: 'managed',
    fields: termFields,
    entries: [{ id: 'e1', values: { code: 'NET30', display_name: 'Net 30', discount_percent: 2 }, bcLastModifiedAt: null, lastSyncedAt: null }],
    canManage: true,
    deleteDisabledReason: null,
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('ReferenceListClient', () => {
  it('non-admin sees no Add/Edit/Delete/Sync', () => {
    render(<ReferenceListClient data={page({ canManage: false })} selectOptions={{}} />);
    expect(screen.getByText('NET30')).toBeInTheDocument();
    for (const name of [/^add/i, /^edit/i, /^delete/i, /sync with bc/i]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('edit shows ChangePreview with only the changed field', async () => {
    render(<ReferenceListClient data={page()} selectOptions={{}} />);
    fireEvent.click(screen.getByRole('button', { name: /^edit/i }));
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: 'Net thirty' } });
    fireEvent.click(screen.getByRole('button', { name: /review changes/i }));
    expect(screen.getByText('These changes will be saved to Business Central')).toBeInTheDocument();
    expect(screen.getByText('Description: Net 30 → Net thirty')).toBeInTheDocument();
    expect(screen.queryByText(/Discount %:/)).toBeNull();
    actions.saveReferenceEntry.mockResolvedValue({ ok: true, entry: {}, warning: 'Heads up' });
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(actions.saveReferenceEntry).toHaveBeenCalledWith('paymentTerms', {
      id: 'e1',
      original: { code: 'NET30', display_name: 'Net 30', discount_percent: 2 },
      edited: { code: 'NET30', display_name: 'Net thirty', discount_percent: 2 },
    }));
    expect(await screen.findByText('Heads up')).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it('an old invalid BC value in an untouched field does not block editing another field', async () => {
    const fields: FieldSpec[] = [
      ...termFields,
      { name: 'due_date_calculation', bcName: 'dueDateCalculation', label: 'Due date calculation', type: 'dateFormula', editable: true },
    ];
    const entries = [{ id: 'e1', values: { code: 'NET30', display_name: 'Net 30', discount_percent: 2, due_date_calculation: '<weird>' }, bcLastModifiedAt: null, lastSyncedAt: null }];
    render(<ReferenceListClient data={page({ fields, entries })} selectOptions={{}} />);
    fireEvent.click(screen.getByRole('button', { name: /^edit/i }));
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: 'Net thirty' } });
    fireEvent.click(screen.getByRole('button', { name: /review changes/i }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Description: Net 30 → Net thirty')).toBeInTheDocument();
  });

  it('a changed invalid field is still rejected on edit', () => {
    const fields: FieldSpec[] = [
      ...termFields,
      { name: 'due_date_calculation', bcName: 'dueDateCalculation', label: 'Due date calculation', type: 'dateFormula', editable: true },
    ];
    render(<ReferenceListClient data={page({ fields })} selectOptions={{}} />);
    fireEvent.click(screen.getByRole('button', { name: /^edit/i }));
    fireEvent.change(screen.getByLabelText(/Due date calculation/), { target: { value: 'banana' } });
    fireEvent.click(screen.getByRole('button', { name: /review changes/i }));
    expect(screen.getByRole('alert').textContent).toMatch(/BC date formula/);
  });

  it('action error is shown inline', async () => {
    actions.deleteReferenceEntry.mockResolvedValue({ ok: false, error: 'Used by 12 customers' });
    render(<ReferenceListClient data={page()} selectOptions={{}} />);
    fireEvent.click(screen.getByRole('button', { name: /^delete/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm delete/i }));
    expect(await screen.findByText('Used by 12 customers')).toBeInTheDocument();
    expect(actions.deleteReferenceEntry).toHaveBeenCalledWith('paymentTerms', 'e1');
  });

  it('price group delete is disabled with the reason', () => {
    render(<ReferenceListClient data={page({ deleteDisabledReason: 'Cannot delete price groups here' })} selectOptions={{}} />);
    expect(screen.getByRole('button', { name: /^delete/i })).toBeDisabled();
    expect(screen.getByText('Cannot delete price groups here')).toBeInTheDocument();
  });

  it('read-only list shows only Sync and the managed-in-BC line', async () => {
    actions.syncReferenceList.mockResolvedValue({ ok: true, inserted: 2, updated: 1, deleted: 0 });
    render(<ReferenceListClient data={page({ mode: 'readOnly' })} selectOptions={{}} />);
    expect(screen.getByText('Managed in Business Central — copied here to pick from.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^add/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^edit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^delete/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /sync with bc/i }));
    expect(await screen.findByText('Synced: 2 added, 1 updated, 0 removed')).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it('sync button shows Syncing… while a sync runs, then goes back', async () => {
    let resolve!: (v: unknown) => void;
    actions.syncReferenceList.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<ReferenceListClient data={page()} selectOptions={{}} />);
    fireEvent.click(screen.getByRole('button', { name: /sync with bc/i }));
    const busy = await screen.findByRole('button', { name: /syncing…/i });
    expect(busy.querySelector('svg')).toHaveClass('animate-spin');
    resolve({ ok: true, inserted: 0, updated: 0, deleted: 0 });
    expect(await screen.findByRole('button', { name: /sync with bc/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /syncing…/i })).toBeNull();
  });

  it('invalid percent shows validation message and does not call the action', () => {
    render(<ReferenceListClient data={page()} selectOptions={{}} />);
    fireEvent.click(screen.getByRole('button', { name: /^edit/i }));
    fireEvent.change(screen.getByLabelText(/Discount %/), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: /review changes/i }));
    expect(screen.getByRole('alert').textContent).toMatch(/Discount %/);
    expect(screen.queryByText('These changes will be saved to Business Central')).toBeNull();
    expect(actions.saveReferenceEntry).not.toHaveBeenCalled();
  });

  it('required select starts blank and requires a choice', () => {
    const fields: FieldSpec[] = [
      { name: 'j', bcName: 'J', label: 'Tax jurisdiction', type: 'select', required: true, isKey: true, editable: true, optionsFrom: 'taxJurisdictions' },
    ];
    render(
      <ReferenceListClient
        data={page({ key: 'taxDetails', fields, entries: [] })}
        selectOptions={{ taxJurisdictions: [{ code: 'A', label: 'A — Alpha' }] }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^add/i }));
    expect((screen.getByLabelText(/Tax jurisdiction/) as HTMLSelectElement).value).toBe('');
    expect(screen.getByRole('option', { name: 'Select…' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /review changes/i }));
    expect(screen.getByRole('alert').textContent).toMatch(/Tax jurisdiction is required/);
    expect(actions.saveReferenceEntry).not.toHaveBeenCalled();
  });
  it('taxDetails filtered by jurisdiction pre-fills tax_jurisdiction_code on Add', () => {
    const fields: FieldSpec[] = [
      { name: 'tax_jurisdiction_code', bcName: 'J', label: 'Tax jurisdiction', type: 'select', required: true, isKey: true, editable: true, optionsFrom: 'taxJurisdictions' },
    ];
    render(
      <ReferenceListClient
        data={page({ key: 'taxDetails', fields, entries: [] })}
        selectOptions={{ taxJurisdictions: [{ code: 'A', label: 'A — Alpha' }, { code: 'B', label: 'B — Beta' }] }}
        fixedValues={{ tax_jurisdiction_code: 'B' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^add/i }));
    expect((screen.getByLabelText(/Tax jurisdiction/) as HTMLSelectElement).value).toBe('B');
  });

  it('does not render listHidden fields as columns', () => {
    const fields: FieldSpec[] = [
      ...termFields,
      { name: 'secret', bcName: 'secret', label: 'Secret note', type: 'text', editable: true, listHidden: true },
    ];
    render(<ReferenceListClient data={page({ fields })} selectOptions={{}} />);
    expect(screen.queryByText('Secret note')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^edit/i }));
    expect(screen.getByLabelText(/Secret note/)).toBeInTheDocument();
  });
});
