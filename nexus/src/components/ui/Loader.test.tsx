import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LoadingOverlay, PageLoader } from './Loader';

afterEach(cleanup);

describe('LoadingOverlay', () => {
  it('while loading: announces it, with the spinner, label and top bar', () => {
    const { container } = render(<LoadingOverlay show label="Loading invoices…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading invoices…');
    expect(container.querySelector('[data-loader="spinner"]')).toBeInTheDocument();
    expect(container.querySelector('[data-loader="bar"]')).toBeInTheDocument();
  });

  it('never blocks clicks on the content under it', () => {
    render(<LoadingOverlay show label="Loading…" />);
    expect(screen.getByRole('status').closest('[data-loader="overlay"]')).toHaveClass('pointer-events-none');
  });

  it('nothing when not loading', () => {
    const { container } = render(<LoadingOverlay show={false} label="Loading…" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('PageLoader', () => {
  it('a centred loader for page changes', () => {
    render(<PageLoader />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });
});
