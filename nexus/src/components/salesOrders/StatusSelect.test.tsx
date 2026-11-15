import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusSelect } from './StatusSelect';

afterEach(cleanup);

describe('StatusSelect', () => {
  it('shows the five labels', () => {
    render(<StatusSelect value="draft" onChange={() => {}} />);
    for (const label of ['Draft', 'Final', 'Pulled', 'Shipped', 'Invoiced']) {
      expect(screen.getByRole('option', { name: label })).toBeInTheDocument();
    }
  });

  it('is a glass pill whose label is coloured by the current status, with room for the chevron', () => {
    render(<StatusSelect value="final" onChange={() => {}} />);
    const select = screen.getByRole('combobox', { name: 'Status' });
    expect(select.className).toContain('text-yellow-');
    expect(select.className).toContain('rounded-full');
    expect(select.className).toContain('pr-9');
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
