import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SalesOrderItemOption } from '@/app/actions/salesOrders';
import type { LineDraft } from '@/types/salesOrders';
import { SalesOrderLinesTable } from './SalesOrderLinesTable';

vi.mock('@/app/actions/salesOrders', () => ({}));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const items: SalesOrderItemOption[] = [
  { bc_item_number: 'P100', display_name: 'Pesto sauce', unit_price: 12.5, base_unit_of_measure_code: 'CASE' },
  { bc_item_number: 'M200', display_name: 'Marinara', unit_price: 8, base_unit_of_measure_code: 'EA' },
];
const line = (over: Partial<LineDraft> = {}): LineDraft => ({
  key: 'k1', id: 'l1', item_number: 'P100', description: 'Pesto sauce', quantity: 2, unit_price: null,
  discount_percent: 0, unit_of_measure_code: 'CASE', amount_incl_tax: null, estimate_price: 12.5, bc_unit_price: null, ...over,
});
afterEach(cleanup);

const setup = (lines: LineDraft[], locked = false) => {
  const onChange = vi.fn();
  render(<SalesOrderLinesTable lines={lines} items={items} locked={locked} onChange={onChange} />);
  return onChange;
};

describe('SalesOrderLinesTable', () => {
  it('shows the exact headers', () => {
    setup([]);
    for (const h of ['Item', 'Qty', 'Unit price', 'Disc %', 'Amount incl. tax']) {
      expect(screen.getByText(h)).toBeInTheDocument();
    }
  });

  it('always ends with one blank row; picking an item adds a line', () => {
    const onChange = setup([line()]);
    expect(screen.getAllByPlaceholderText('Add item…')).toHaveLength(1);
    fireEvent.click(screen.getByPlaceholderText('Add item…'));
    expect(screen.getByText('P100 – Pesto sauce')).toBeInTheDocument();
    expect(screen.getByText('M200 – Marinara')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Add item…'), { target: { value: 'pesto' } });
    expect(screen.queryByText('M200 – Marinara')).toBeNull();
    fireEvent.click(screen.getByText('P100 – Pesto sauce'));
    const next = onChange.mock.calls[0][0] as LineDraft[];
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({
      item_number: 'P100', quantity: 1, unit_of_measure_code: 'CASE', estimate_price: 12.5, unit_price: null, bc_unit_price: null,
    });
    expect(next[1].key).toBeTruthy();
    expect(next[1].id).toBeUndefined();
  });

  it('shows the estimate with (est.) when price is blank, and typing sets the price', () => {
    const onChange = setup([line()]);
    expect(screen.getByText('12.50 (est.)')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Unit price'), { target: { value: '9.75' } });
    expect((onChange.mock.calls[0][0] as LineDraft[])[0].unit_price).toBe(9.75);
  });

  it('a synced blank-price line shows BC’s price without (est.)', () => {
    setup([line({ bc_unit_price: 11.25 })]);
    expect(screen.getByText('11.25')).toBeInTheDocument();
    expect(screen.queryByText(/\(est\.\)/)).toBeNull();
  });

  it('an unsynced blank-price line shows the estimate with (est.)', () => {
    setup([line({ bc_unit_price: null })]);
    expect(screen.getByText('12.50 (est.)')).toBeInTheDocument();
  });

  it('amount incl. tax is read-only and shows a dash when null', () => {
    setup([line()]);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByLabelText('Amount incl. tax')).toBeNull();
  });

  it('delete removes the line', () => {
    const onChange = setup([line(), line({ key: 'k2', id: 'l2', item_number: 'M200' })]);
    fireEvent.click(within(screen.getAllByRole('row')[1]).getByLabelText('Remove line'));
    expect((onChange.mock.calls[0][0] as LineDraft[]).map((l) => l.key)).toEqual(['k2']);
  });

  it('locked disables inputs and hides the blank row', () => {
    setup([line()], true);
    expect(screen.queryByPlaceholderText('Add item…')).toBeNull();
    for (const el of screen.getAllByRole('spinbutton')) expect(el).toBeDisabled();
    expect(screen.getByLabelText('Remove line')).toBeDisabled();
  });

  it('keyboard: ArrowDown + Enter picks the active item without submitting a form', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <SalesOrderLinesTable lines={[]} items={items} locked={false} onChange={onChange} />
      </form>,
    );
    const box = screen.getByRole('combobox');
    fireEvent.focus(box);
    expect(box).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[1].id);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect((onChange.mock.calls[0][0] as LineDraft[])[0].item_number).toBe('M200');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('the item list is not clipped by an overflow ancestor (rendered outside the table, fixed under the input)', () => {
    setup([]);
    const box = screen.getByRole('combobox');
    fireEvent.focus(box);
    const list = screen.getByRole('listbox');
    expect(box).toHaveAttribute('aria-controls', list.id);
    for (let el = list.parentElement; el; el = el.parentElement) {
      expect(el.className).not.toMatch(/overflow-(x-|y-)?(auto|hidden|scroll)/);
    }
    expect(list.closest('table')).toBeNull();
    expect(list.style.position === 'fixed' || list.className.includes('fixed')).toBe(true);
  });

  it('aria-controls is set only while the list is open (the list is not in the DOM when closed)', () => {
    setup([]);
    const box = screen.getByRole('combobox');
    expect(box).not.toHaveAttribute('aria-controls');
    fireEvent.focus(box);
    expect(box).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box).not.toHaveAttribute('aria-controls');
  });

  it('keyboard: typing filters, Escape closes', () => {
    setup([]);
    const box = screen.getByRole('combobox');
    fireEvent.change(box, { target: { value: 'pesto' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('Qty can be cleared and retyped; empty reverts on blur', () => {
    const onChange = setup([line({ quantity: 12 })]);
    const qty = screen.getByLabelText('Qty') as HTMLInputElement;
    expect(qty.value).toBe('12');
    fireEvent.change(qty, { target: { value: '' } });
    expect(qty.value).toBe('');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(qty, { target: { value: '5' } });
    expect(qty.value).toBe('5');
    expect((onChange.mock.calls.at(-1)![0] as LineDraft[])[0].quantity).toBe(5);
    fireEvent.change(qty, { target: { value: '' } });
    fireEvent.blur(qty);
    expect(qty.value).toBe('12');
    fireEvent.change(qty, { target: { value: '0' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('Disc %: empty commits 0, over 100 reverts', () => {
    const onChange = setup([line({ discount_percent: 10 })]);
    const disc = screen.getByLabelText('Disc %') as HTMLInputElement;
    fireEvent.change(disc, { target: { value: '150' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(disc);
    expect(disc.value).toBe('10');
    fireEvent.change(disc, { target: { value: '' } });
    fireEvent.blur(disc);
    expect((onChange.mock.calls.at(-1)![0] as LineDraft[])[0].discount_percent).toBe(0);
  });
});
