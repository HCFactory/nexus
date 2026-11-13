export interface BillcomErrorDetails {
  status: number;
  statusText: string;
  code?: string;
  message?: string;
  url: string;
}

export class BillcomApiError extends Error {
  readonly details: BillcomErrorDetails;

  constructor(details: BillcomErrorDetails) {
    super(details.message || `${details.status} ${details.statusText}`);
    this.name = 'BillcomApiError';
    this.details = details;
  }
}

export class BillcomAuthError extends BillcomApiError {
  constructor(details: BillcomErrorDetails) {
    super(details);
    this.name = 'BillcomAuthError';
  }
}

export class BillcomSessionExpiredError extends BillcomApiError {
  constructor(details: BillcomErrorDetails) {
    super(details);
    this.name = 'BillcomSessionExpiredError';
  }
}

/** Bill.com returns BDC_1144 when the hourly request ceiling is exceeded. */
export class BillcomRateLimitError extends BillcomApiError {
  constructor(details: BillcomErrorDetails) {
    super(details);
    this.name = 'BillcomRateLimitError';
  }
}

/**
 * Raised before any request is sent, so there is no HTTP status (status 0).
 * Extends BillcomApiError so a caller catching Bill.com errors also sees it.
 */
export class BillcomConnectionDisabledError extends BillcomApiError {
  constructor(connectionId: string) {
    super({
      status: 0,
      statusText: 'Disabled',
      message: `Bill.com connection ${connectionId} is disabled. Enable it in Admin before making requests.`,
      url: '',
    });
    this.name = 'BillcomConnectionDisabledError';
  }
}
