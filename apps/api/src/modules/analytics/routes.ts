import { Router } from 'express';
import type { AppDeps } from '../../types.js';
import { asyncHandler, uuidParam } from '../../lib/http.js';
import { requireTenant, tenantTx } from '../../middleware/request-context.js';
import { AppError } from '../../lib/errors.js';
import { departmentScopeOf, requireUser, requirePermission, userPrincipal } from '../../middleware/auth.js';
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
      const analytics = await tenantTx(deps, req, (trx) => getDepartmentAnalytics(trx, t.id, departmentId));
      res.json({ analytics });
    }),
  );

  r.get(
    '/overview',
    user,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      // A department-scoped HOD sees only their own departments; the route refuses nobody the page would serve.
      const scope = departmentScopeOf(userPrincipal(req).grants, 'analytics:read');
      if (scope === 'NONE') throw AppError.forbidden('PERMISSION_DENIED', 'Missing permission analytics:read');
      const overview = await tenantTx(deps, req, (trx) => getOverviewAnalytics(trx, t.id, scope === 'ALL' ? null : scope));
      res.json({ overview });
    }),
  );

  return r;
}

