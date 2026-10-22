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

export class BillcomConnectionDisabledError extends Error {
  constructor(connectionId: string) {
    super(
      `Bill.com connection ${connectionId} is disabled. Enable it in Admin before making requests.`,
    );
    this.name = 'BillcomConnectionDisabledError';
  }
}
