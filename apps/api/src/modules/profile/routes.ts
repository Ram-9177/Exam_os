import { Router } from 'express';
import type { Knex } from 'knex';
import { PhotoUploadSchema, UserSignatureUploadSchema } from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { asyncHandler, validateBody, body } from '../../lib/http.js';
import { AppError } from '../../lib/errors.js';
import { requireTenant, tenantTx } from '../../middleware/request-context.js';
import { requireUser, userPrincipal } from '../../middleware/auth.js';
import type { JwtService } from '../auth/jwt.js';
import { updateUserSignature, removeUserSignature } from '../users/service.js';
import {
  getStudentProfile,
  uploadStudentPhoto,
  getStudentPhoto,
  getIdCardData,
  verifyStudentByHash,
} from './service.js';

async function resolveTargetStudentId(
  trx: Knex.Transaction,
  tenantId: string,
  principal: { kind: string; userId: string },
  queryUserId?: unknown
): Promise<string> {
  if (principal.kind === 'STUDENT') return principal.userId;
  if (typeof queryUserId === 'string' && queryUserId.trim().length > 0) return queryUserId.trim();
  // If staff did not specify a student, fallback to the first student enrolled in this tenant
  const firstStudent = await trx('users')
    .where({ tenant_id: tenantId, kind: 'STUDENT' })
    .orderBy('created_at', 'asc')
    .first('id');
  return firstStudent?.id ?? principal.userId;
}

export function profileRoutes(deps: AppDeps, jwt: JwtService): Router {
  const r = Router();
  const user = requireUser({ deps, jwt });

  r.get(
    '/profile',
    user,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const targetUserId = await tenantTx(deps, req, (trx) =>
        resolveTargetStudentId(trx, t.id, p, req.query['userId'])
      );
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
      const targetUserId = await tenantTx(deps, req, (trx) =>
        resolveTargetStudentId(trx, t.id, p, req.query['userId'])
      );
      res.json(await tenantTx(deps, req, (trx) => uploadStudentPhoto(deps, trx, t.id, targetUserId, input)));
    }),
  );

  r.get(
    '/profile/photo',
    user,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const targetUserId = await tenantTx(deps, req, (trx) =>
        resolveTargetStudentId(trx, t.id, p, req.query['userId'])
      );
      const photo = await tenantTx(deps, req, (trx) => getStudentPhoto(deps, trx, t.id, targetUserId));
      res.setHeader('Content-Type', photo.mimeType);
      res.setHeader('X-Document-Sha256', photo.sha256);
      res.send(photo.data);
    }),
  );

  r.get(
    '/profile/signature',
    user,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const targetUserId = await tenantTx(deps, req, (trx) =>
        resolveTargetStudentId(trx, t.id, p, req.query['userId'])
      );
      const row = await tenantTx(deps, req, (trx) =>
        trx('users')
          .where({ tenant_id: t.id, id: targetUserId })
          .first('signature_data_url as signatureDataUrl', 'signature_updated_at as signatureUpdatedAt')
      );
      if (!row) throw AppError.notFound('USER_NOT_FOUND', 'User not found');
      res.json(row);
    }),
  );

  r.put(
    '/profile/signature',
    user,
    validateBody(UserSignatureUploadSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const input = body<typeof UserSignatureUploadSchema>(req);
      const targetUserId = await tenantTx(deps, req, (trx) =>
        resolveTargetStudentId(trx, t.id, p, req.query['userId'])
      );
      const result = await tenantTx(deps, req, (trx) =>
        updateUserSignature(trx, {
          tenantId: t.id,
          userId: targetUserId,
          signatureDataUrl: input.signatureDataUrl,
          actorId: p.userId,
        })
      );
      res.json(result);
    }),
  );

  r.delete(
    '/profile/signature',
    user,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const targetUserId = await tenantTx(deps, req, (trx) =>
        resolveTargetStudentId(trx, t.id, p, req.query['userId'])
      );
      const result = await tenantTx(deps, req, (trx) =>
        removeUserSignature(trx, {
          tenantId: t.id,
          userId: targetUserId,
          actorId: p.userId,
        })
      );
      res.json(result);
    }),
  );

  r.get(
    '/profile/id-card',
    user,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const host = req.get('host') ?? t.slug;
      const targetUserId = await tenantTx(deps, req, (trx) =>
        resolveTargetStudentId(trx, t.id, p, req.query['userId'])
      );
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
