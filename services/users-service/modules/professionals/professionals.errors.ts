const statuses = {
  forbidden: 403,
  not_found: 404,
  invalid_request: 422,
  invalid_professional_user: 422,
  invalid_reference: 422,
  catalog_unavailable: 503,
} as const;

export class ProfessionalError extends Error {
  readonly status: number;
  readonly code: keyof typeof statuses;

  constructor(code: keyof typeof statuses) {
    super(code);
    this.name = 'ProfessionalError';
    this.code = code;
    this.status = statuses[code];
  }
}
