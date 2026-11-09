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

export class ValidationError extends Error {
  readonly status = 422;
  readonly code = 'invalid_request';

  constructor(message = 'Invalid request.') {
    super(message);
    this.name = 'ValidationError';
  }
}
