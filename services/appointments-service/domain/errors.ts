// Domain errors carry an HTTP status and a stable code; the shared errorHandler
// answers with both and never with the message.

export class NotFoundError extends Error {
  readonly status = 404;
  readonly code = 'not_found';

  constructor(message = 'Resource not found.') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends Error {
  readonly status = 403;
  readonly code = 'forbidden';

  constructor(message = 'Operation not allowed for this role.') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** 422. `code` names the rule that failed, for example outside_working_hours. */
export class ValidationError extends Error {
  readonly status = 422;
  readonly code: string;

  constructor(message = 'Invalid request.', code = 'invalid_request') {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}
