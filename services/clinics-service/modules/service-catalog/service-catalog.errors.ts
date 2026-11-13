const codes = { 403: 'forbidden', 404: 'not_found', 422: 'invalid_request' } as const;

/** The shared HTTP handler exposes status/code, never the internal message. */
export class CatalogError extends Error {
  readonly status: keyof typeof codes;
  readonly code: string;

  constructor(status: keyof typeof codes) {
    super(codes[status]);
    this.name = 'CatalogError';
    this.status = status;
    this.code = codes[status];
  }
}
