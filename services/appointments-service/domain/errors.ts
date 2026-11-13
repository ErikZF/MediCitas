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

/** 409. A status change the appointment life cycle does not allow (RF13). */
export class TransitionError extends Error {
  readonly status = 409;
  readonly code = 'invalid_transition';

  constructor(message = 'Status change not allowed.') {
    super(message);
    this.name = 'TransitionError';
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

/** 409. The request clashes with data that already exists; `code` names which. */
export class ConflictError extends Error {
  readonly status = 409;
  readonly code: string;

  constructor(message = 'Conflict.', code = 'conflict') {
    super(message);
    this.name = 'ConflictError';
    this.code = code;
  }
}
