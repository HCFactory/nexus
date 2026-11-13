import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusSelect } from './StatusSelect';

afterEach(cleanup);

describe('StatusSelect', () => {
  it('shows the five labels with their colours', () => {
    render(<StatusSelect value="draft" onChange={() => {}} />);
    const expected: [string, string][] = [
      ['Draft', 'gray'],
      ['Final', 'yellow'],
      ['Pulled', 'orange'],
      ['Shipped', 'blue'],
      ['Invoiced', 'green'],
    ];
    for (const [label, colour] of expected) {
      const option = screen.getByRole('option', { name: label });
      expect(option.className).toContain(`bg-${colour}-`);
    }
  });

  it('colours the select by the current status', () => {
    render(<StatusSelect value="final" onChange={() => {}} />);
    expect(screen.getByRole('combobox', { name: 'Status' }).className).toContain('bg-yellow-');
  });

  it('Shipped and Invoiced cannot be chosen by hand', () => {
    render(<StatusSelect value="draft" onChange={() => {}} />);
    expect(screen.getByRole('option', { name: 'Shipped' })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Invoiced' })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Final' })).not.toBeDisabled();
  });

  it('reports the chosen status', () => {
    const onChange = vi.fn();
    render(<StatusSelect value="draft" onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'pulled' } });
    expect(onChange).toHaveBeenCalledWith('pulled');
  });

  it('is disabled once BC owns the status', () => {
    render(<StatusSelect value="shipped" onChange={() => {}} />);
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeDisabled();
  });
});
