import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }));
vi.mock('@/app/actions/notificationSettings', () => ({
  getNotificationSettings: mocks.get,
  saveNotificationSettings: mocks.save,
}));

import { ReceivablesNotificationsCard } from './ReceivablesNotificationsCard';

afterEach(cleanup);
beforeEach(() => {
  mocks.get.mockReset();
  mocks.save.mockReset();
});

const view = (over = {}) => ({
  available: true,
  canEdit: true,
  backupChargeEmails: ['ar@example.com'],
  cardSavedEmails: ['fundraisers@hawaiicandyfactory.com'],
  ...over,
});

const list = (name: string) => screen.getByRole('group', { name });

describe('ReceivablesNotificationsCard', () => {
  it('shows the Receivables section with both lists', async () => {
    mocks.get.mockResolvedValue(view());
    render(<ReceivablesNotificationsCard />);
    expect(await screen.findByRole('heading', { name: 'Receivables' })).toBeInTheDocument();
    expect(within(list('Backup payment charged')).getByText('ar@example.com')).toBeInTheDocument();
    expect(within(list('Backup payment method saved')).getByText('fundraisers@hawaiicandyfactory.com')).toBeInTheDocument();
  });

  it('add and remove addresses, then Save sends both lists', async () => {
    mocks.get.mockResolvedValue(view());
    mocks.save.mockImplementation(async (lists) => ({ available: true, canEdit: true, ...lists }));
    render(<ReceivablesNotificationsCard />);
    const charged = await screen.findByRole('group', { name: 'Backup payment charged' });
    fireEvent.change(within(charged).getByRole('textbox'), { target: { value: 'boss@example.com' } });
    fireEvent.click(within(charged).getByRole('button', { name: 'Add' }));
    fireEvent.click(within(list('Backup payment method saved')).getByRole('button', { name: 'Remove fundraisers@hawaiicandyfactory.com' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({ backupChargeEmails: ['ar@example.com', 'boss@example.com'], cardSavedEmails: [] }),
    );
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeInTheDocument();
  });

  it('Enter adds the address; an invalid one shows a message and is not added', async () => {
    mocks.get.mockResolvedValue(view({ backupChargeEmails: [] }));
    render(<ReceivablesNotificationsCard />);
    const charged = await screen.findByRole('group', { name: 'Backup payment charged' });
    const box = within(charged).getByRole('textbox');
    fireEvent.change(box, { target: { value: 'nope' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(within(charged).getByRole('alert')).toHaveTextContent('Enter a valid email address.');
    fireEvent.change(box, { target: { value: 'Ops@Example.com' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(within(charged).getByText('ops@example.com')).toBeInTheDocument();
    expect(within(charged).queryByRole('alert')).toBeNull();
  });

  it('a save error is shown', async () => {
    mocks.get.mockResolvedValue(view());
    mocks.save.mockRejectedValue(new Error('Only admins can change notification emails.'));
    render(<ReceivablesNotificationsCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Only admins can change notification emails.')).toBeInTheDocument();
  });

  it('read-only for non-admins', async () => {
    mocks.get.mockResolvedValue(view({ canEdit: false }));
    render(<ReceivablesNotificationsCard />);
    expect(await screen.findByText('ar@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByText('Only admins can change these.')).toBeInTheDocument();
  });

  it('before the database update: a short note instead of the lists', async () => {
    mocks.get.mockResolvedValue(view({ available: false }));
    render(<ReceivablesNotificationsCard />);
    expect(await screen.findByText(/Not available yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('hidden for staff without receivables access', async () => {
    mocks.get.mockResolvedValue(null);
    const { container } = render(<ReceivablesNotificationsCard />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
