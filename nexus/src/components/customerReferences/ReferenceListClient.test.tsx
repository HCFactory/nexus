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
});
