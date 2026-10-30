import { Router } from 'express';
import { PhotoUploadSchema } from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { asyncHandler, validateBody, body } from '../../lib/http.js';
import { requireTenant, tenantTx } from '../../middleware/request-context.js';
import { requireUser, userPrincipal } from '../../middleware/auth.js';
import type { JwtService } from '../auth/jwt.js';
import {
  getStudentProfile,
  uploadStudentPhoto,
  getStudentPhoto,
  getIdCardData,
  verifyStudentByHash,
} from './service.js';

export function profileRoutes(deps: AppDeps, jwt: JwtService): Router {
  const r = Router();
  const user = requireUser({ deps, jwt });

  r.get(
    '/profile',
    user,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const targetUserId =
        p.kind === 'STAFF' && req.query['userId'] && typeof req.query['userId'] === 'string'
          ? req.query['userId']
          : p.userId;
      res.json(await tenantTx(deps, req, (trx) => getStudentProfile(deps, trx, t.id, targetUserId)));
    }),
  );

  r.post(
    '/profile/photo',
    user,
    validateBody(PhotoUploadSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const input = body<typeof PhotoUploadSchema>(req);
      res.json(await tenantTx(deps, req, (trx) => uploadStudentPhoto(deps, trx, t.id, p.userId, input)));
    }),
  );

  r.get(
    '/profile/photo',
    user,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const targetUserId =
        p.kind === 'STAFF' && req.query['userId'] && typeof req.query['userId'] === 'string'
          ? req.query['userId']
          : p.userId;
      const photo = await tenantTx(deps, req, (trx) => getStudentPhoto(deps, trx, t.id, targetUserId));
      res.setHeader('Content-Type', photo.mimeType);
      res.setHeader('X-Document-Sha256', photo.sha256);
      res.send(photo.data);
    }),
  );

  r.get(
    '/profile/id-card',
    user,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const host = req.get('host') ?? t.slug;
      const targetUserId =
        p.kind === 'STAFF' && req.query['userId'] && typeof req.query['userId'] === 'string'
          ? req.query['userId']
          : p.userId;
      res.json(await tenantTx(deps, req, (trx) => getIdCardData(deps, trx, t.id, targetUserId, host)));
    }),
  );

  r.get(
    '/verify-student/:hash',
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const hash = req.params['hash'] ?? '';
      res.json(await tenantTx(deps, req, (trx) => verifyStudentByHash(deps, trx, t.id, hash)));
    }),
  );

  return r;
}
