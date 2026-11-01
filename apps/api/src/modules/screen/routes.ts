import { Router } from 'express';
import { ScreenFrameUploadSchema } from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { asyncHandler, validateBody, body, uuidParam } from '../../lib/http.js';
import { requireTenant, tenantTx } from '../../middleware/request-context.js';
import { requireUser, requirePermission, userPrincipal } from '../../middleware/auth.js';
import { costly } from '../../middleware/rate-limit.js';
import type { JwtService } from '../auth/jwt.js';
import { uploadScreenFrame, listScreenFrames, screenFrameImage } from './service.js';

/**
 * Screen watch (ADR 0012).
 * - POST /student/attempts/:id/screen-frames      the workspace sends a picture of the shared screen
 * - GET  /proctor/attempts/:id/screen-frames      proctors list the pictures and the gaps (server clock)
 * - GET  /proctor/screen-frames/:frameId.jpg      one picture
 */
export function screenRoutes(deps: AppDeps, jwt: JwtService): Router {
  const r = Router();
  const user = requireUser({ deps, jwt });

  r.post(
    '/student/attempts/:id/screen-frames',
    user,
    requirePermission('attempts:own'),
    costly(deps, 'screen-frame', 12, 60),
    validateBody(ScreenFrameUploadSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const device = (req.header('x-device-session') ?? '').trim() || null;
      res.status(201).json(await tenantTx(deps, req, (trx) => uploadScreenFrame(deps, trx, t.id, p.userId, uuidParam(req, 'id'), device, body<typeof ScreenFrameUploadSchema>(req))));
    }),
  );

  r.get(
    '/proctor/attempts/:id/screen-frames',
    user,
    requirePermission('attempts:read'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      res.json(await tenantTx(deps, req, (trx) => listScreenFrames(deps, trx, t.id, p.userId, uuidParam(req, 'id'), req.ctx.requestId)));
    }),
  );

  r.get(
    '/proctor/screen-frames/:frameId.jpg',
    user,
    requirePermission('attempts:read'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const data = await tenantTx(deps, req, (trx) => screenFrameImage(trx, t.id, uuidParam(req, 'frameId')));
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(data);
    }),
  );
  return r;
}
