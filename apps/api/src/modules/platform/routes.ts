import { Router, type RequestHandler } from 'express';
import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@examos/db';
import { z } from 'zod';
import { PlatformLoginSchema, TenantCreateSchema, TenantSettingsSchema, TENANT_TRANSITIONS, assertTransition, ROLE_CODES, STAFF_BUNDLES, STAFF_BUNDLE_CODES, type StaffBundle } from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import type { JwtService } from '../auth/jwt.js';
import { asyncHandler, validateBody, body, uuidParam } from '../../lib/http.js';
import { AppError } from '../../lib/errors.js';
import { safeEqual, sha256Hex } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { provisionTenant } from '../tenants/service.js';
import { verifyTotp } from './totp.js';
import { issueActivation, staffSeats } from '../users/service.js';

const PlatformStaffRolesBody = z.object({
  roles: z.array(z.enum(ROLE_CODES).refine((r) => r !== 'STUDENT', 'staff only')).max(15).default([]),
  bundle: z.enum(STAFF_BUNDLE_CODES as [StaffBundle, ...StaffBundle[]]).optional(),
});

export function platformRoutes(deps: AppDeps, jwt: JwtService): Router {
  const r = Router();
  const gate: RequestHandler = asyncHandler(async (req, res, next) => {
    const token = req.header('authorization')?.replace(/^Bearer /, '') ?? '';
    if (token) {
      let claims;
      try { claims = await jwt.verifyAccessToken(token); } catch { throw AppError.unauthorized('TOKEN_INVALID'); }
      if (claims.tid !== 'platform') throw AppError.forbidden('PLATFORM_ACCESS_REQUIRED');
      const session = await deps.db('platform_sessions').where({ id: claims.sfm, admin_id: claims.sub, token_hash: sha256Hex(token) }).whereNull('revoked_at').where('expires_at', '>', deps.clock.now()).first();
      if (!session) throw AppError.unauthorized('SESSION_REVOKED');
      res.locals['platformAdminId'] = claims.sub;
      res.locals['platformSessionId'] = claims.sfm;
    } else {
      // Bootstrap key: development and automated tests only. Production accepts nothing but the super admin's session.
      if (deps.config.isProduction || !deps.config.PLATFORM_BOOTSTRAP_KEY || !safeEqual(req.header('x-platform-key') ?? '', deps.config.PLATFORM_BOOTSTRAP_KEY)) throw AppError.unauthorized('PLATFORM_ACCESS_REQUIRED');
    }
    req.ctx.principal = { type: 'PLATFORM' };
    next();
  });
  r.post('/auth/login', rateLimit(deps, { pool: 'platform-login', limit: 10, windowSeconds: 300, keyOf: (req) => String(req.ip) }), validateBody(PlatformLoginSchema), asyncHandler(async (req, res) => {
    const input = body<typeof PlatformLoginSchema>(req);
    const result = await deps.db.transaction(async (trx) => {
      const admin = await trx('platform_admins').where({ singleton: true }).forNoKeyUpdate().first();
      const now = deps.clock.now();
      const passwordOk = admin ? await bcrypt.compare(input.password, admin.password_hash) : false;
      const secret = admin ? await deps.secrets.resolve(admin.totp_secret_ref) : null;
      const step = secret ? verifyTotp(secret, input.otp, now, Number(admin.last_totp_step)) : null;
      if (!admin || admin.email !== input.email || !passwordOk || step === null || (admin.locked_until && new Date(admin.locked_until) > now)) {
        if (admin) await trx('platform_admins').where('id', admin.id).update({ failed_attempts: admin.failed_attempts + 1, locked_until: admin.failed_attempts >= 4 ? new Date(now.getTime() + 15 * 60_000) : admin.locked_until });
        await audit(trx, { tenantId: null, actorType: 'PLATFORM', actorId: null, action: 'platform.login_refused', entityType: 'platform', entityId: null, metadata: { ip: req.ip } });
        return null;
      }
      const sessionId = randomUUID();
      const token = await jwt.signAccessToken({ userId: admin.id, tenantId: 'platform', sessionFamilyId: sessionId, jti: randomUUID(), now });
      const expiresAt = new Date(now.getTime() + deps.config.JWT_ACCESS_TTL_SECONDS * 1000);
      await trx('platform_sessions').insert({ id: sessionId, admin_id: admin.id, token_hash: sha256Hex(token), ip: req.ip, expires_at: expiresAt });
      await trx('platform_admins').where('id', admin.id).update({ failed_attempts: 0, locked_until: null, last_totp_step: step });
      await audit(trx, { tenantId: null, actorType: 'PLATFORM', actorId: admin.id, action: 'platform.login', entityType: 'platform_session', entityId: sessionId, metadata: { ip: req.ip } });
      return { accessToken: token, expiresAt: expiresAt.toISOString(), email: admin.email };
    });
    if (!result) throw AppError.unauthorized('LOGIN_FAILED', 'Invalid credentials or authentication code');
    res.json(result);
  }));
  r.use(gate);
  r.post('/auth/logout', asyncHandler(async (_req, res) => {
    // The bootstrap key (dev/test) has no session to revoke; only a session token ends a session.
    const sessionId = res.locals['platformSessionId'] as string | undefined;
    if (sessionId) await deps.db('platform_sessions').where('id', sessionId).update({ revoked_at: deps.clock.now() });
    res.status(204).end();
  }));
  r.get('/tenants', asyncHandler(async (_req, res) => {
    const tenants = await deps.db('tenants').select('id', 'slug', 'name', 'status', 'timezone', 'staff_login_limit as staffLoginLimit').orderBy('name');
    const rows = [];
    for (const t of tenants) {
      const usage = await withTenantTx(deps.db, t.id, async (trx) => ({
        staffCount: Number((await trx('users').where({ tenant_id: t.id, kind: 'STAFF' }).whereIn('status', ['ACTIVE', 'PENDING_ACTIVATION']).count('* as count').first())?.count),
        studentCount: Number((await trx('users').where({ tenant_id: t.id, kind: 'STUDENT' }).count('* as count').first())?.count),
      }));
      rows.push({ ...t, ...usage, domains: (await deps.db('tenant_domains').where('tenant_id', t.id).orderBy('is_primary', 'desc')).map((d) => d.host) });
    }
    res.json({ tenants: rows });
  }));
  r.post('/tenants', validateBody(TenantCreateSchema), asyncHandler(async (req, res) => {
    res.status(201).json(await provisionTenant(deps, body<typeof TenantCreateSchema>(req), req.ctx.requestId));
  }));
  r.patch('/tenants/:id', validateBody(TenantSettingsSchema), asyncHandler(async (req, res) => {
    const id = uuidParam(req, 'id');
    const input = body<typeof TenantSettingsSchema>(req);
    const hosts = await withTenantTx(deps.db, id, async (trx) => {
      const t = await trx('tenants').where('id', id).forNoKeyUpdate().first();
      if (!t) throw AppError.notFound('TENANT_NOT_FOUND');
      if (input.staffLoginLimit) {
        const count = await trx('users').where({ tenant_id: id, kind: 'STAFF' }).whereIn('status', ['ACTIVE', 'PENDING_ACTIVATION']).count('* as count').first();
        if (Number(count?.count) > input.staffLoginLimit) throw AppError.conflict('STAFF_LIMIT_BELOW_USAGE', 'Disable an unused staff account before lowering this limit');
      }
      if (input.status && input.status !== t.status) assertTransition('tenant', TENANT_TRANSITIONS, t.status, input.status);
      const oldDomains = await trx('tenant_domains').where('tenant_id', id).select('host');
      if (input.domains) {
        const conflict = await trx('tenant_domains').whereIn('host', input.domains).whereNot('tenant_id', id).first();
        if (conflict) throw AppError.conflict('DOMAIN_IN_USE', 'One of these domains already belongs to another tenant');
        await trx('tenant_domains').where('tenant_id', id).delete();
        await trx('tenant_domains').insert([...new Set(input.domains)].map((host, i) => ({ tenant_id: id, host, is_primary: i === 0 })));
      }
      await trx('tenants').where('id', id).update({ name: input.name ?? t.name, status: input.status ?? t.status, staff_login_limit: input.staffLoginLimit ?? t.staff_login_limit, updated_at: trx.fn.now() });
      if (input.status === 'SUSPENDED') await trx('auth_sessions').where('tenant_id', id).whereNull('revoked_at').update({ revoked_at: trx.fn.now() });
      await audit(trx, { tenantId: id, actorType: 'PLATFORM', actorId: res.locals['platformAdminId'] ?? null, action: 'tenant.settings_updated', entityType: 'tenant', entityId: id, metadata: input });
      return [...oldDomains.map((d) => d.host), ...(input.domains ?? [])];
    });
    for (const host of hosts) await deps.redis.del(`tenant:host:${host}`);
    res.status(204).end();
  }));
  r.get('/me', asyncHandler(async (_req, res) => {
    const id = res.locals['platformAdminId'] as string | undefined;
    const admin = id ? await deps.db('platform_admins').where('id', id).first('email', 'created_at') : null;
    res.json({ email: admin?.email ?? null, via: id ? 'SESSION' : 'BOOTSTRAP_KEY' });
  }));
  r.get('/overview', asyncHandler(async (_req, res) => {
    const tenants = await deps.db('tenants').select('id', 'name', 'slug', 'status');
    const rows = [];
    for (const t of tenants) {
      rows.push(await withTenantTx(deps.db, t.id, async (trx) => {
        const exams = await trx('exams').where('tenant_id', t.id).select('status').count('* as count').groupBy('status');
        const live = await trx('exam_attempts').where('tenant_id', t.id).whereIn('status', ['ACTIVE', 'RECOVERY_PENDING', 'SUSPENDED']).count('* as count').first();
        const openIncidents = await trx('proctor_incidents').where({ tenant_id: t.id, status: 'PROCTOR_REVIEW' }).count('* as count').first();
        return { tenantId: t.id, name: t.name, slug: t.slug, status: t.status, examsByStatus: Object.fromEntries(exams.map((e) => [e.status, Number(e.count)])), attemptsInProgress: Number(live?.count ?? 0), openIncidents: Number(openIncidents?.count ?? 0) };
      }));
    }
    res.json({ tenants: rows });
  }));
  r.get('/tenants/:id/staff', asyncHandler(async (req, res) => {
    const id = uuidParam(req, 'id');
    res.json(await withTenantTx(deps.db, id, (trx) => staffSeats(trx, id)));
  }));
  /** The super admin sets any staff login's duties, including the tenant admin's own (who cannot self-grant). */
  r.put('/tenants/:id/staff/:userId/roles', validateBody(PlatformStaffRolesBody), asyncHandler(async (req, res) => {
    const id = uuidParam(req, 'id');
    const userId = uuidParam(req, 'userId');
    const input = body<typeof PlatformStaffRolesBody>(req);
    await withTenantTx(deps.db, id, async (trx) => {
      const u = await trx('users').where({ id: userId, tenant_id: id }).first('kind');
      if (!u) throw AppError.notFound('USER_NOT_FOUND');
      if (u.kind !== 'STAFF') throw AppError.unprocessable('ROLE_KIND_MISMATCH', 'Only staff logins hold duty roles');
      const wanted = new Set<string>(input.roles);
      if (input.bundle) for (const r of STAFF_BUNDLES[input.bundle]) wanted.add(r);
      if (wanted.size === 0) throw AppError.unprocessable('ROLES_REQUIRED', 'A staff login needs at least one role');
      const current = await trx('role_grants').where({ tenant_id: id, user_id: userId, scope_type: 'TENANT' }).whereNull('scope_id').whereNull('revoked_at').select('id', 'role_code');
      for (const g of current) if (!wanted.has(g.role_code)) await trx('role_grants').where('id', g.id).update({ revoked_at: trx.fn.now() });
      const have = new Set(current.map((g) => g.role_code));
      for (const role of wanted) if (!have.has(role)) await trx('role_grants').insert({ tenant_id: id, user_id: userId, role_code: role, scope_type: 'TENANT', scope_id: null, granted_by: null });
      await audit(trx, { tenantId: id, actorType: 'PLATFORM', actorId: res.locals['platformAdminId'] ?? null, action: 'platform.staff_roles_set', entityType: 'user', entityId: userId, metadata: { roles: [...wanted] } });
    });
    res.status(204).end();
  }));
  /** Account recovery for a locked-out tenant admin: a fresh single-use activation link to their own mailbox. */
  r.post('/tenants/:id/staff/:userId/reissue-activation', asyncHandler(async (req, res) => {
    const id = uuidParam(req, 'id');
    const userId = uuidParam(req, 'userId');
    const dispatchId = await withTenantTx(deps.db, id, async (trx) => {
      const u = await trx('users').where({ id: userId, tenant_id: id, kind: 'STAFF' }).first('id', 'email', 'full_name', 'status');
      if (!u) throw AppError.notFound('USER_NOT_FOUND');
      if (!['ACTIVE', 'PENDING_ACTIVATION'].includes(u.status)) throw AppError.conflict('USER_DISABLED', 'Enable the account before sending a new activation link');
      await trx('users').where('id', u.id).update({ failed_login_count: 0, locked_until: null, updated_at: trx.fn.now() });
      await audit(trx, { tenantId: id, actorType: 'PLATFORM', actorId: res.locals['platformAdminId'] ?? null, action: 'platform.activation_reissued', entityType: 'user', entityId: u.id });
      return issueActivation(deps, trx, { tenantId: id, userId: u.id, email: u.email, fullName: u.full_name });
    });
    res.status(202).json({ dispatchId });
  }));
  r.get('/audit', asyncHandler(async (_req, res) => {
    res.json({ events: await deps.db('audit_events').whereNull('tenant_id').orderBy('seq', 'desc').limit(100) });
  }));
  return r;
}
