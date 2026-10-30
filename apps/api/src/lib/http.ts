import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { AppError } from './errors.js';

/** Express 4 does not catch rejected promises; every async route goes through this. */
export function asyncHandler<Req extends Request = Request>(fn: (req: Req, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req as Req, res, next).catch(next);
  };
}

export function validateBody<S extends ZodTypeAny>(schema: S): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(
        AppError.badRequest(
          'VALIDATION_FAILED',
          'Request body failed validation',
          result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        ),
      );
      return;
    }
    (req as Request & { validBody: z.infer<S> }).validBody = result.data;
    next();
  };
}

export function validateQuery<S extends ZodTypeAny>(schema: S): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      next(AppError.badRequest('VALIDATION_FAILED', 'Query failed validation', result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))));
      return;
    }
    (req as Request & { validQuery: z.infer<S> }).validQuery = result.data;
    next();
  };
}

export function body<S extends ZodTypeAny>(req: Request): z.infer<S> {
  return (req as Request & { validBody: z.infer<S> }).validBody;
}
export function query<S extends ZodTypeAny>(req: Request): z.infer<S> {
  return (req as Request & { validQuery: z.infer<S> }).validQuery;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function uuidParam(req: Request, name: string): string {
  const v = req.params[name];
  if (!v || !UUID_RE.test(v)) throw AppError.badRequest('INVALID_ID', `${name} must be a UUID`);
  return v;
}
