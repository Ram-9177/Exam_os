import { Router } from 'express';
import { z } from 'zod';
import { LoginSchema, RefreshSchema, ActivateSchema } from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { asyncHandler, validateBody, body, validateQuery, query } from '../../lib/http.js';
import { requireTenant } from '../../middleware/request-context.js';
import { requireUser, userPrincipal } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import type { AuthService } from './service.js';
import type { OidcService } from './oidc.js';
import type { JwtService } from './jwt.js';

const OidcStartSchema = z.object({ redirectUri: z.string().url() });
const OidcCallbackSchema = z.object({ code: z.string().min(1), state: z.string().min(1) });

export function authRoutes(deps: AppDeps, auth: AuthService, oidc: OidcService, jwt: JwtService): Router {
  const r = Router();
  const loginLimiter = rateLimit(deps, { pool: 'auth-login', limit: 20, windowSeconds: 300, keyOf: (req) => `${req.ip}:${String((req.body as { email?: string })?.email ?? '')}` });
  const activateLimiter = rateLimit(deps, { pool: 'auth-activate', limit: 60, windowSeconds: 300, keyOf: (req) => String(req.ip) });

  r.post(
    '/login',
    loginLimiter,
    validateBody(LoginSchema),
    asyncHandler(async (req, res) => {
      const { email, password } = body<typeof LoginSchema>(req);
      const pair = await auth.login(requireTenant(req).id, email, password, req.ctx.requestId, req.header('user-agent') ?? undefined);
      res.json(pair);
    }),
  );
  r.post(
    '/refresh',
    validateBody(RefreshSchema),
    asyncHandler(async (req, res) => {
      res.json(await auth.refresh(requireTenant(req).id, body<typeof RefreshSchema>(req).refreshToken, req.ctx.requestId));
    }),
  );
  r.post(
    '/activate',
    activateLimiter,
    validateBody(ActivateSchema),
    asyncHandler(async (req, res) => {
      const { token, password } = body<typeof ActivateSchema>(req);
      res.json(await auth.activate(requireTenant(req).id, token, password, req.ctx.requestId));
    }),
  );
  r.post(
    '/logout',
    requireUser({ deps, jwt }),
    asyncHandler(async (req, res) => {
      const p = userPrincipal(req);
      await auth.logout(requireTenant(req).id, p.sessionFamilyId, p.userId, req.ctx.requestId);
      res.status(204).end();
    }),
  );
  r.get(
    '/me',
    requireUser({ deps, jwt }),
    asyncHandler(async (req, res) => {
      const p = userPrincipal(req);
      res.json({ userId: p.userId, email: p.email, kind: p.kind, grants: p.grants, tenant: requireTenant(req) });
    }),
  );
  r.get(
    '/oidc/start',
    validateQuery(OidcStartSchema),
    asyncHandler(async (req, res) => {
      res.json(await oidc.start(requireTenant(req).id, query<typeof OidcStartSchema>(req).redirectUri));
    }),
  );
  r.post(
    '/oidc/callback',
    validateBody(OidcCallbackSchema),
    asyncHandler(async (req, res) => {
      const { code, state } = body<typeof OidcCallbackSchema>(req);
      res.json(await oidc.callback(requireTenant(req).id, code, state, req.ctx.requestId));
    }),
  );
  r.get(
    '/.well-known/jwks.json',
    asyncHandler(async (_req, res) => {
      res.json(await jwt.jwks());
    }),
  );
  return r;
}
