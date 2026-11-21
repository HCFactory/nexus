import { describe, expect, it } from 'vitest';
import { pageTitle } from './pageTitle';

describe('pageTitle (top bar)', () => {
  it('receivables pages, including sales invoices, sit under Sales', () => {
    expect(pageTitle('/receivables')).toBe('Sales');
    expect(pageTitle('/receivables/invoices')).toBe('Sales');
    expect(pageTitle('/receivables/invoices/abc')).toBe('Sales');
  });
  it('keeps the other titles', () => {
    expect(pageTitle('/')).toBe('Dashboard');
    expect(pageTitle('/admin/users')).toBe('Admin Panel');
    expect(pageTitle('/customers/1')).toBe('Customers');
  });
});
