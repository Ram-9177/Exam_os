import { Router } from 'express';
import type { AppDeps } from '../../types.js';
import { asyncHandler, uuidParam } from '../../lib/http.js';
import { requireTenant, tenantTx } from '../../middleware/request-context.js';
import { requireUser, requirePermission } from '../../middleware/auth.js';
import type { JwtService } from '../auth/jwt.js';
import { getDepartmentAnalytics, getOverviewAnalytics } from './service.js';

export function analyticsRoutes(deps: AppDeps, jwt: JwtService): Router {
  const r = Router();
  const user = requireUser({ deps, jwt });

  r.get(
    '/department/:departmentId',
    user,
    requirePermission('analytics:read', (req) => ({ departmentId: req.params['departmentId'] })),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const departmentId = uuidParam(req, 'departmentId');
      res.json(await tenantTx(deps, req, (trx) => getDepartmentAnalytics(trx, t.id, departmentId)));
    }),
  );

  r.get(
    '/overview',
    user,
    requirePermission('analytics:read'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      res.json(await tenantTx(deps, req, (trx) => getOverviewAnalytics(trx, t.id)));
    }),
  );

  return r;
}

