const statuses = {
  conflict: 409,
  bootstrap_unavailable: 503,
  forbidden: 403,
  identity_out_of_date: 401,
  not_found: 404,
  invalid_request: 422,
} as const;

export class UserManagementError extends Error {
  readonly status: number;
  readonly code: keyof typeof statuses;

  constructor(code: keyof typeof statuses) {
    super(code);
    this.name = 'UserManagementError';
    this.code = code;
    this.status = statuses[code];
  }
}
