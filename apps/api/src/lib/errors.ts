import type { Problem } from '@examos/contracts';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly options: { retryable?: boolean; errors?: Problem['errors']; expose?: boolean } = {},
  ) {
    super(message);
  }

  static badRequest(code: string, message: string, errors?: Problem['errors']): AppError {
    return new AppError(400, code, message, { errors });
  }
  static unauthorized(code = 'UNAUTHORIZED', message = 'Authentication required'): AppError {
    return new AppError(401, code, message);
  }
  static forbidden(code = 'FORBIDDEN', message = 'Not allowed'): AppError {
    return new AppError(403, code, message);
  }
  static notFound(code = 'NOT_FOUND', message = 'Not found'): AppError {
    return new AppError(404, code, message);
  }
  static conflict(code: string, message: string): AppError {
    return new AppError(409, code, message);
  }
  static unprocessable(code: string, message: string): AppError {
    return new AppError(422, code, message);
  }
  static tooMany(code = 'RATE_LIMITED', message = 'Too many requests'): AppError {
    return new AppError(429, code, message, { retryable: true });
  }
}

export function toProblem(err: unknown, requestId: string): Problem {
  if (err instanceof AppError) {
    return {
      type: `urn:examos:error:${err.code}`,
      title: err.message,
      status: err.status,
      code: err.code,
      requestId,
      retryable: err.options.retryable ?? false,
      ...(err.options.errors ? { errors: err.options.errors } : {}),
    };
  }
  const anyErr = err as { code?: string; message?: string; name?: string };
  if (anyErr?.code === 'ILLEGAL_TRANSITION') {
    return { type: 'urn:examos:error:ILLEGAL_TRANSITION', title: anyErr.message ?? 'Illegal transition', status: 409, code: 'ILLEGAL_TRANSITION', requestId, retryable: false };
  }
  // PostgreSQL unique violation surfaced without a domain mapping: report as conflict, never as 500 with internals.
  if (anyErr?.code === '23505') {
    return { type: 'urn:examos:error:CONFLICT', title: 'Conflict', status: 409, code: 'CONFLICT', requestId, retryable: false };
  }
  // Database triggers that guard business invariants raise check_violation with a stable code as the message.
  if (anyErr?.code === '23514' && /STAFF_LOGIN_LIMIT|ROLE_KIND_MISMATCH/.test(anyErr.message ?? '')) {
    const code = /STAFF_LOGIN_LIMIT/.test(anyErr.message ?? '') ? 'STAFF_LOGIN_LIMIT' : 'ROLE_KIND_MISMATCH';
    return { type: `urn:examos:error:${code}`, title: code === 'STAFF_LOGIN_LIMIT' ? 'This tenant has no free staff login. Disable an unused staff account or assign roles to an existing one.' : 'Student accounts can only hold the student role', status: code === 'STAFF_LOGIN_LIMIT' ? 409 : 422, code, requestId, retryable: false };
  }
  if (anyErr?.code === '40001' || anyErr?.code === '40P01') {
    return { type: 'urn:examos:error:SERIALIZATION', title: 'Please retry', status: 409, code: 'SERIALIZATION_FAILURE', requestId, retryable: true };
  }
  return { type: 'about:blank', title: 'Internal error', status: 500, code: 'INTERNAL', requestId, retryable: false };
}
