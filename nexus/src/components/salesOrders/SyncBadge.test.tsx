import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncBadge } from './SyncBadge';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
const confirmSpy = vi.spyOn(window, 'confirm');

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const noop = () => {};

describe('SyncBadge', () => {
  it('pending reads "Sending to BC…"', () => {
    render(<SyncBadge state="pending" error={null} onRetry={noop} onOverwrite={noop} />);
    expect(screen.getByText('Sending to BC…')).toBeInTheDocument();
  });

  it('synced reads "In BC"', () => {
    render(<SyncBadge state="synced" error={null} onRetry={noop} onOverwrite={noop} />);
    expect(screen.getByText('In BC')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('failed shows the error and a Try again button', () => {
    const onRetry = vi.fn();
    render(<SyncBadge state="failed" error="BC is down" onRetry={onRetry} onOverwrite={noop} />);
    expect(screen.getByText('Failed: BC is down')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('conflict asks for confirmation in the app dialog before overwriting', () => {
    const onOverwrite = vi.fn();
    render(<SyncBadge state="conflict" error={null} onRetry={noop} onOverwrite={onOverwrite} />);
    expect(screen.getByText('Changed in BC')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: "Overwrite BC with Nexus's version" }));
    expect(onOverwrite).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }));
    expect(onOverwrite).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('cancelling the confirmation does not overwrite', () => {
    const onOverwrite = vi.fn();
    render(<SyncBadge state="conflict" error={null} onRetry={noop} onOverwrite={onOverwrite} />);
    fireEvent.click(screen.getByRole('button', { name: "Overwrite BC with Nexus's version" }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOverwrite).not.toHaveBeenCalled();
  });

  it('hides the action buttons when the user cannot edit', () => {
    render(<SyncBadge state="failed" error="x" canAct={false} onRetry={noop} onOverwrite={noop} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});
