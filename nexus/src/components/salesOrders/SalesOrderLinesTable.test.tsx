import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SalesOrderItemOption } from '@/app/actions/salesOrders';
import type { LineDraft } from '@/types/salesOrders';
import { SalesOrderLinesTable } from './SalesOrderLinesTable';

vi.mock('@/app/actions/salesOrders', () => ({}));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const items: SalesOrderItemOption[] = [
  { bc_item_number: 'P100', display_name: 'Pesto sauce', unit_price: 12.5, base_unit_of_measure_code: 'CASE', tax_group_code: 'TAXABLE' },
  { bc_item_number: 'M200', display_name: 'Marinara', unit_price: 8, base_unit_of_measure_code: 'EA', tax_group_code: 'TAXABLE' },
];
const line = (over: Partial<LineDraft> = {}): LineDraft => ({
  key: 'k1', id: 'l1', item_number: 'P100', description: 'Pesto sauce', quantity: 2, unit_price: null,
  discount_percent: 0, unit_of_measure_code: 'CASE', amount_incl_tax: null, estimate_price: 12.5, bc_unit_price: null, bc_line_discount_percent: null, ...over,
});
afterEach(cleanup);

const setup = (lines: LineDraft[], locked = false) => {
  const onChange = vi.fn();
  render(<SalesOrderLinesTable lines={lines} items={items} locked={locked} onChange={onChange} />);
  return onChange;
};

/** The table with its lines held in state, as the form does. */
function Stateful({ initial }: { initial: LineDraft[] }) {
  const [lines, setLines] = useState(initial);
  return <SalesOrderLinesTable lines={lines} items={items} locked={false} onChange={setLines} />;
}
const amountCell = () => screen.getAllByRole('row')[1].querySelectorAll('td')[4];

describe('SalesOrderLinesTable', () => {
  it('shows the exact headers', () => {
    setup([]);
    for (const h of ['Item', 'Qty', 'Unit price', 'Disc %', 'Amount excl. tax']) {
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

  it('a blank-price row shows the estimate in the input’s value, not as text under it', () => {
    setup([line()]);
    expect(screen.getByLabelText('Unit price')).toHaveValue(12.5);
    expect((screen.getByLabelText('Unit price') as HTMLInputElement).value).toBe('12.50');
    expect(screen.queryByText(/12\.50/)).toBeNull();
    expect(screen.queryByText(/\(est\.\)/)).toBeNull();
  });

  it('a synced blank-price line shows BC’s price in the input', () => {
    setup([line({ bc_unit_price: 11.25 })]);
    expect((screen.getByLabelText('Unit price') as HTMLInputElement).value).toBe('11.25');
  });

  it('typing a price stores it as typed; blurring keeps it', () => {
    const onChange = setup([line()]);
    const price = screen.getByLabelText('Unit price') as HTMLInputElement;
    fireEvent.change(price, { target: { value: '9.7' } });
    expect(price.value).toBe('9.7');
    expect((onChange.mock.calls.at(-1)![0] as LineDraft[])[0].unit_price).toBe(9.7);
    fireEvent.blur(price);
    expect((onChange.mock.calls.at(-1)![0] as LineDraft[])[0].unit_price).toBe(9.7);
  });

  it('typing a price updates the amount cell before blur', () => {
    render(<Stateful initial={[line({ quantity: 2 })]} />);
    expect(amountCell()).toHaveTextContent('25.00');
    fireEvent.change(screen.getByLabelText('Unit price'), { target: { value: '10' } });
    expect(amountCell()).toHaveTextContent('20.00');
    expect((screen.getByLabelText('Unit price') as HTMLInputElement).value).toBe('10');
    fireEvent.change(screen.getByLabelText('Disc %'), { target: { value: '5' } });
    expect(amountCell()).toHaveTextContent('19.00');
  });

  it('clearing a typed price stores null and shows the effective value again', () => {
    render(<Stateful initial={[line({ unit_price: 9 })]} />);
    const price = screen.getByLabelText('Unit price') as HTMLInputElement;
    expect(price.value).toBe('9.00');
    fireEvent.change(price, { target: { value: '' } });
    expect(price.value).toBe('');
    fireEvent.blur(price);
    expect(price.value).toBe('12.50');
  });

  it('the amount excl. tax is live: qty × effective price less discount, no tax', () => {
    setup([line({ quantity: 2, unit_price: 10, discount_percent: 5 })]);
    expect(amountCell()).toHaveTextContent('19.00');
    cleanup();
    setup([line({ quantity: 1, estimate_price: 2.73, amount_incl_tax: 2.74 })]);
    expect(amountCell()).toHaveTextContent('2.73');
  });

  it('changing quantity updates the amount cell without a save and clears BC’s values', () => {
    const onChange = setup([line({ bc_unit_price: 11, bc_line_discount_percent: 5, amount_incl_tax: 20.9 })]);
    fireEvent.change(screen.getByLabelText('Qty'), { target: { value: '3' } });
    expect((onChange.mock.calls.at(-1)![0] as LineDraft[])[0]).toMatchObject({
      quantity: 3, bc_unit_price: null, bc_line_discount_percent: null, amount_incl_tax: null,
    });
    cleanup();
    render(<Stateful initial={[line({ discount_percent: null })]} />);
    expect(amountCell()).toHaveTextContent('25.00');
    fireEvent.change(screen.getByLabelText('Qty'), { target: { value: '3' } });
    expect(amountCell()).toHaveTextContent('37.50');
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

  it('Disc %: over 100 reverts; clearing a typed discount goes back to null', () => {
    const onChange = setup([line({ discount_percent: 10 })]);
    const disc = screen.getByLabelText('Disc %') as HTMLInputElement;
    expect(disc.value).toBe('10');
    fireEvent.change(disc, { target: { value: '150' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(disc);
    expect(onChange).not.toHaveBeenCalled();
    expect(disc.value).toBe('10');
    fireEvent.change(disc, { target: { value: '' } });
    fireEvent.blur(disc);
    expect((onChange.mock.calls.at(-1)![0] as LineDraft[])[0].discount_percent).toBeNull();
  });

  it('Disc %: typing then blurring sets the discount', () => {
    const onChange = setup([line({ discount_percent: null })]);
    const disc = screen.getByLabelText('Disc %') as HTMLInputElement;
    expect(disc.value).toBe('');
    fireEvent.change(disc, { target: { value: '7.5' } });
    fireEvent.blur(disc);
    expect((onChange.mock.calls.at(-1)![0] as LineDraft[])[0].discount_percent).toBe(7.5);
  });

  it('Disc %: blank shows the estimated discount in the input before sync', () => {
    setup([line({ discount_percent: null, estimate_discount_percent: 5 })]);
    expect((screen.getByLabelText('Disc %') as HTMLInputElement).value).toBe('5');
    expect(screen.queryByText(/\(est\.\)/)).toBeNull();
  });

  it('Disc %: blank shows BC’s discount after sync', () => {
    setup([line({ discount_percent: null, estimate_discount_percent: 5, bc_line_discount_percent: 12 })]);
    expect((screen.getByLabelText('Disc %') as HTMLInputElement).value).toBe('12');
  });

  it('Disc %: a typed 0 beats BC’s discount (shown blank)', () => {
    setup([line({ discount_percent: 0, estimate_discount_percent: 5, bc_line_discount_percent: 12 })]);
    expect((screen.getByLabelText('Disc %') as HTMLInputElement).value).toBe('');
  });

  it('a new line leaves the discount to BC (null)', () => {
    const onChange = setup([]);
    fireEvent.click(screen.getByPlaceholderText('Add item…'));
    fireEvent.click(screen.getByText('P100 – Pesto sauce'));
    expect((onChange.mock.calls[0][0] as LineDraft[])[0].discount_percent).toBeNull();
  });
});
