import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FieldSpec } from '@/types/customerReferences';
import { ChangePreview } from './ChangePreview';

afterEach(() => cleanup());

const fields: FieldSpec[] = [
  { name: 'tax_type', bcName: 'Tax_Type', label: 'Tax type', type: 'text', required: true, isKey: true, editable: true },
  { name: 'maximum_amount_qty', bcName: 'Maximum_Amount_Qty', label: 'Maximum amount/qty', type: 'number', editable: true },
  { name: 'tax_below_maximum', bcName: 'Tax_Below_Maximum', label: 'Tax below maximum %', type: 'percent', editable: true },
  { name: 'note', bcName: 'Note', label: 'Note', type: 'text', editable: true },
  { name: 'active', bcName: 'Active', label: 'Active', type: 'boolean', editable: true },
  { name: 'tax_type_ro', bcName: 'RO', label: 'Read only', type: 'text', editable: false },
];

const noop = vi.fn();

describe('ChangePreview', () => {
  it('shows a cleared rate as the 0 BC will store, not (empty)', () => {
    render(
      <ChangePreview
        fields={fields}
        original={{ tax_type: 'Sales', tax_below_maximum: 4.5 }}
        edited={{ tax_type: 'Sales', tax_below_maximum: null }}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByText('Tax below maximum %: 4.5 → 0')).toBeInTheDocument();
    expect(screen.queryByText(/\(empty\)/)).toBeNull();
  });

  it('does not list a field whose BC value would not change (0 cleared to blank)', () => {
    render(
      <ChangePreview
        fields={fields}
        original={{ tax_type: 'Sales', maximum_amount_qty: 0 }}
        edited={{ tax_type: 'Sales', maximum_amount_qty: null }}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByText('Nothing has changed.')).toBeInTheDocument();
  });

  it('on create lists every editable field with the value BC will receive', () => {
    render(
      <ChangePreview
        fields={fields}
        original={null}
        edited={{ tax_type: 'Sales', maximum_amount_qty: null, tax_below_maximum: 6, note: null, active: false }}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([
      'Tax type: Sales',
      'Maximum amount/qty: 0',
      'Tax below maximum %: 6',
      'Note: (empty)',
      'Active: No',
    ]);
  });
});
