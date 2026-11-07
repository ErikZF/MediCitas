// Translates PostgreSQL errors into HTTP responses without leaking database details.
// The message is fixed and safe; the Postgres code and constraint stay on the
// object for logging, never in the response.

export interface PgErrorLike {
  code: string;
  constraint?: string;
  table?: string;
  detail?: string;
}

export interface ErrorMapping {
  status: number;
  code: string;
  message: string;
}

export class DbError extends Error {
  readonly status: number;
  readonly code: string;
  readonly pgCode: string;
  readonly constraint: string | undefined;

  constructor(mapping: ErrorMapping, pg: PgErrorLike, options?: { cause?: unknown }) {
    super(mapping.message, options);
    this.name = 'DbError';
    this.status = mapping.status;
    this.code = mapping.code;
    this.pgCode = pg.code;
    this.constraint = pg.constraint;
  }
}

/** MediCitas schema constraints that carry their own meaning for the client. */
export const DEFAULT_CONSTRAINT_ERRORS: Readonly<Record<string, ErrorMapping>> = {
  no_overlap_professional: {
    status: 409,
    code: 'slot_taken',
    message: 'El espacio ya fue tomado.',
  },
  no_overlap_patient: {
    status: 409,
    code: 'patient_overlap',
    message: 'El paciente ya tiene una cita en ese horario.',
  },
  no_overlap_working_hours: {
    status: 409,
    code: 'schedule_overlap',
    message: 'El horario se solapa con otro bloque del mismo día.',
  },
};

const BY_SQLSTATE: Readonly<Record<string, ErrorMapping>> = {
  '23P01': { status: 409, code: 'overlap', message: 'El recurso se solapa con otro existente.' },
  '23505': { status: 409, code: 'duplicate', message: 'Ya existe un registro con esos datos.' },
  '23503': { status: 422, code: 'invalid_reference', message: 'Una referencia no existe.' },
  '23502': { status: 422, code: 'missing_field', message: 'Falta un dato obligatorio.' },
  '23514': { status: 422, code: 'invalid_value', message: 'Un dato no cumple las reglas del dominio.' },
  '22P02': { status: 422, code: 'invalid_input', message: 'Un dato tiene un formato inválido.' },
  '22007': { status: 422, code: 'invalid_input', message: 'Un dato tiene un formato inválido.' },
  '22008': { status: 422, code: 'invalid_input', message: 'Un dato tiene un formato inválido.' },
  '22003': { status: 422, code: 'invalid_input', message: 'Un dato está fuera de rango.' },
  '22001': { status: 422, code: 'invalid_input', message: 'Un dato es demasiado largo.' },
  '22023': { status: 422, code: 'invalid_input', message: 'Un dato tiene un valor inválido.' },
  '42501': { status: 403, code: 'forbidden', message: 'No tiene permiso para esta operación.' },
  '40001': { status: 409, code: 'concurrency_conflict', message: 'Hubo un conflicto concurrente. Intente de nuevo.' },
  '40P01': { status: 409, code: 'concurrency_conflict', message: 'Hubo un conflicto concurrente. Intente de nuevo.' },
  '57014': { status: 503, code: 'timeout', message: 'La operación tardó demasiado.' },
  '53300': { status: 503, code: 'database_unavailable', message: 'La base de datos no está disponible.' },
  '57P01': { status: 503, code: 'database_unavailable', message: 'La base de datos no está disponible.' },
};

const FALLBACK: ErrorMapping = { status: 500, code: 'database_error', message: 'Error interno de la base de datos.' };
const CONNECTION: ErrorMapping = { status: 503, code: 'database_unavailable', message: 'La base de datos no está disponible.' };

function isPgErrorLike(value: unknown): value is PgErrorLike {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && typeof value.code === 'string'
    && /^[0-9A-Z]{5}$/.test(value.code);
}

/**
 * Finds the Postgres error inside the cause chain.
 * Drizzle 0.44+ wraps the driver error in DrizzleQueryError.cause.
 */
export function findPgError(error: unknown): PgErrorLike | null {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (isPgErrorLike(current)) {
      return current;
    }
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }

  return null;
}

/**
 * Converts an error into a DbError when it comes from Postgres; otherwise returns null.
 * `constraintErrors` lets each service give meaning to its own constraints.
 */
export function mapPgError(
  error: unknown,
  constraintErrors: Readonly<Record<string, ErrorMapping>> = DEFAULT_CONSTRAINT_ERRORS,
): DbError | null {
  if (error instanceof DbError) {
    return error;
  }

  const pg = findPgError(error);

  if (pg === null) {
    return null;
  }

  const byConstraint = pg.constraint !== undefined ? constraintErrors[pg.constraint] : undefined;
  const mapping = byConstraint
    ?? BY_SQLSTATE[pg.code]
    ?? (pg.code.startsWith('08') ? CONNECTION : FALLBACK);

  return new DbError(mapping, pg, { cause: error });
}
