import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { AppDeps } from './types.js';
import { requestContext, resolveTenantByHost } from './middleware/request-context.js';
import { errorHandler } from './middleware/error-handler.js';
import { JwtService } from './modules/auth/jwt.js';
import { AuthService } from './modules/auth/service.js';
import { OidcService } from './modules/auth/oidc.js';
import { authRoutes } from './modules/auth/routes.js';
import { tenantAdminRoutes } from './modules/tenants/routes.js';
import { platformRoutes } from './modules/platform/routes.js';
import { integrationRoutes } from './modules/integration/routes.js';
import { examRoutes } from './modules/exams/routes.js';
import { attemptRoutes } from './modules/attempts/routes.js';
import { proctorRoutes } from './modules/proctoring/routes.js';
import { candidateRoutes } from './modules/candidates/routes.js';
import { profileRoutes } from './modules/profile/routes.js';
import { analyticsRoutes } from './modules/analytics/routes.js';
import { sebRoutes } from './modules/seb/routes.js';
import { evaluationRoutes } from './modules/evaluation/routes.js';
import { AppError } from './lib/errors.js';

export interface App {
  app: Express;
  jwt: JwtService;
  auth: AuthService;
}

/**
 * Route map (all under /api/v1):
 *   /platform/*              bootstrap tenant provisioning (platform key)
 *   /integration/*           Simple Integration API (tenant API keys)
 *   /auth/*                  login, refresh, activation, OIDC, JWKS (host tenant)
 *   /tenant/*                tenant administration (host tenant + user JWT)
 *   /exams/*                 Exam Cell / conduct / hall tickets / readiness board
 *   /student/*               student readiness, admission, answers, results
 *   /proctor/*               signals, incidents, decisions, holds, resume
 *   /candidates/*            forensics, marks, Exam Cell approval, Controller publication
 */
export async function createApp(deps: AppDeps): Promise<App> {
  const jwt = await JwtService.create(deps.config);
  const auth = new AuthService(deps, jwt);
  const oidc = new OidcService(deps, auth);

  const app = express();
  app.disable('x-powered-by');
  // Production sits behind one reverse proxy. Elsewhere only loopback callers (dev tools, tests) may present X-Forwarded-For.
  app.set('trust proxy', deps.config.isProduction ? 1 : 'loopback');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '5mb' }));
  app.use(requestContext());
  if (deps.config.NODE_ENV !== 'test') app.use(pinoHttp({ logger: deps.logger, genReqId: (req) => (req as express.Request).ctx?.requestId ?? 'n/a' }));

  app.get('/healthz', async (_req, res) => {
    try {
      await deps.db.raw('select 1');
      await deps.redis.ping();
      res.json({ ok: true });
    } catch (e) {
      res.status(503).json({ ok: false, error: e instanceof Error ? e.message : 'unhealthy' });
    }
  });

  const api = express.Router();
  // tenant-less surfaces
  api.use('/platform', platformRoutes(deps, jwt));
  api.use('/integration/v1', integrationRoutes(deps));
  // host-tenant surfaces
  const tenantScoped = express.Router();
  tenantScoped.use(resolveTenantByHost(deps));
  tenantScoped.use('/auth', authRoutes(deps, auth, oidc, jwt));
  tenantScoped.use('/tenant', tenantAdminRoutes(deps, jwt));
  tenantScoped.use('/exams', examRoutes(deps, jwt));
  tenantScoped.use('/student', attemptRoutes(deps, jwt));
  tenantScoped.use('/student', profileRoutes(deps, jwt));
  tenantScoped.use('/proctor', proctorRoutes(deps, jwt));
  tenantScoped.use('/candidates', candidateRoutes(deps, jwt));
  tenantScoped.use('/analytics', analyticsRoutes(deps, jwt));
  tenantScoped.use('/', sebRoutes(deps, jwt));
  tenantScoped.use('/', evaluationRoutes(deps, jwt));
  api.use('/', tenantScoped);
  app.use('/api/v1', api);

  app.use((_req, _res, next) => next(AppError.notFound('ROUTE_NOT_FOUND', 'No such route')));
  app.use(errorHandler(deps.logger));
  return { app, jwt, auth };
}
