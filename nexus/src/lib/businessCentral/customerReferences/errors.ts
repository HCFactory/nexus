export class ReferencePageUnavailableError extends Error {
  constructor(service: string, pageNumber: number, status: number) {
    super(
      `Reference list is unavailable (HTTP ${status}). Publish page ${pageNumber} ` +
        `as an OData web service named "${service}" in this Business Central environment, ` +
        `and confirm the app registration has read/write access to its table.`
    );
    this.name = 'ReferencePageUnavailableError';
  }
}

/** HTTP 412 or 409 Request_EntityChanged: the record changed in Business Central since it was read. */
export class BcConflictError extends Error {
  constructor(message = 'Record changed in Business Central (conflict)') {
    super(message);
    this.name = 'BcConflictError';
  }
}

/** Any other non-OK Business Central response; message is BC's own message. */
export class BcReferenceError extends Error {
  readonly status: number;
  readonly bcMessage: string;
  /** BC's error code (body.error.code), e.g. Internal_EntityWithSameKeyExists; '' when absent. */
  readonly bcCode: string;
  constructor(status: number, bcMessage: string, bcCode = '') {
    super(bcMessage);
    this.name = 'BcReferenceError';
    this.status = status;
    this.bcMessage = bcMessage;
    this.bcCode = bcCode;
  }
}

export class ReferenceInUseError extends Error {
  constructor(message = 'Reference record is in use') {
    super(message);
    this.name = 'ReferenceInUseError';
  }
}
