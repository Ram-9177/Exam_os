import type { ClientNet } from '../../lib/client-net.js';
import bcrypt from 'bcrypt';
import { randomUUID, randomBytes } from 'node:crypto';
import { withTenantTx, type Knex } from '@examos/db';
import type { AppDeps } from '../../types.js';
import { AppError } from '../../lib/errors.js';
import { randomToken, sha256Hex } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { USER_TRANSITIONS, assertTransition, PRIVILEGED_MFA_ROLES } from '@examos/contracts';
import { issueActivation, issuePasswordReset } from '../users/service.js';
import type { JwtService } from './jwt.js';
import { newTotpSecret, verifyTotp } from '../platform/totp.js';

const BCRYPT_ROUNDS = 12;
const MAX_FAILED_LOGINS = 5;
/** A refresh retried with the just-rotated token inside this window is treated as a lost response, once. */
const REFRESH_RETRY_GRACE_MS = 30_000;
const LOCKOUT_MINUTES = 15;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; email: string; fullName: string; kind: string };
}

export class AuthService {
  constructor(
    private readonly deps: AppDeps,
    private readonly jwt: JwtService,
  ) {}

  async hashPassword(pw: string): Promise<string> {
    return bcrypt.hash(pw, BCRYPT_ROUNDS);
  }

  /** Local password login with lockout and optional TOTP MFA. SSO is the default where configured (spec §4). */
  async login(tenantId: string, email: string, password: string, requestId: string, fingerprint?: string, net?: ClientNet, mfaCode?: string): Promise<TokenPair> {
    const now = this.deps.clock.now();
    const user = await withTenantTx(this.deps.db, tenantId, (trx) => trx('users').where({ tenant_id: tenantId, email: email.toLowerCase() }).first());
    // Constant-work path: compare against a dummy hash when the user does not exist.
    const hash = user?.password_hash ?? '$2b$12$C6UzMDM.H6dfI/f/IKcEeO6jN0h3n8eXbQF1Zq4c3iGq4U0z2eWqC';
    const ok = await bcrypt.compare(password, hash);
    const locked = !!user?.locked_until && new Date(user.locked_until) > now;
    if (!user || !user.password_hash || user.status !== 'ACTIVE' || locked || !ok) {
      if (user) {
        // Failure bookkeeping commits in its own transaction; the refusal below must not roll it back.
        await withTenantTx(this.deps.db, tenantId, async (trx) => {
          // Attempts during a lock do not extend it, and an expired lock starts the count again.
          const failed = locked ? (user.failed_login_count ?? 0) : (user.locked_until ? 0 : (user.failed_login_count ?? 0)) + 1;
          if (!locked) {
            const lockNow = failed >= MAX_FAILED_LOGINS;
            await trx('users')
              .where('id', user.id)
              .update({ failed_login_count: failed, locked_until: lockNow ? new Date(now.getTime() + LOCKOUT_MINUTES * 60_000) : null, updated_at: trx.fn.now() });
          }
          await audit(trx, { tenantId, actorType: 'USER', actorId: user.id, action: 'auth.login_failed', entityType: 'user', entityId: user.id, requestId, metadata: { locked: locked || failed >= MAX_FAILED_LOGINS, ip: net?.ip ?? null } });
        });
      }
      throw AppError.unauthorized('INVALID_CREDENTIALS', 'Invalid e-mail or password');
    }

    // MFA Challenge for accounts with TOTP enabled
    if (user.totp_enabled && user.totp_secret_ref) {
      if (!mfaCode) {
        throw AppError.unauthorized('MFA_REQUIRED', 'Two-factor authentication code required');
      }
      const secret = await this.deps.secrets.resolve(user.totp_secret_ref);
      const step = verifyTotp(secret, mfaCode, now, Number(user.totp_last_step ?? -1));
      let recoveryUsed = false;
      if (step === null) {
        if (Array.isArray(user.recovery_codes) && user.recovery_codes.includes(mfaCode.toUpperCase())) {
          recoveryUsed = true;
        } else {
          throw AppError.unauthorized('MFA_CODE_INVALID', 'Invalid two-factor authentication code');
        }
      }
      await withTenantTx(this.deps.db, tenantId, async (trx) => {
        if (recoveryUsed) {
          const updatedCodes = (user.recovery_codes as string[]).filter((c) => c !== mfaCode.toUpperCase());
          await trx('users').where('id', user.id).update({ recovery_codes: updatedCodes });
        } else if (step !== null) {
          await trx('users').where('id', user.id).update({ totp_last_step: step });
        }
      });
    }

    return withTenantTx(this.deps.db, tenantId, async (trx) => {
      await trx('users').where('id', user.id).update({ failed_login_count: 0, locked_until: null, last_login_at: trx.fn.now(), updated_at: trx.fn.now() });
      await audit(trx, { tenantId, actorType: 'USER', actorId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, requestId, metadata: { ip: net?.ip ?? null } });
      return this.issueTokens(trx, tenantId, user, { familyId: randomUUID(), parentId: null, fingerprint, net });
    });
  }

  async issueTokens(trx: Knex.Transaction, tenantId: string, user: { id: string; email: string; full_name: string; kind: string }, s: { familyId: string; parentId: string | null; fingerprint?: string; net?: ClientNet }): Promise<TokenPair> {
    const refreshToken = randomToken(48);
    const expiresAt = new Date(this.deps.clock.now().getTime() + this.deps.config.REFRESH_TTL_SECONDS * 1000);
    // Each session row remembers where it was issued from: context for the security auditor, never a verdict.
    await trx('auth_sessions').insert({ tenant_id: tenantId, user_id: user.id, family_id: s.familyId, refresh_token_hash: sha256Hex(refreshToken), parent_id: s.parentId, client_fingerprint: s.fingerprint ?? null, ip: s.net?.ip ?? null, user_agent: s.net?.userAgent ?? null, expires_at: expiresAt });
    const accessToken = await this.jwt.signAccessToken({ userId: user.id, tenantId, sessionFamilyId: s.familyId, jti: randomUUID(), now: this.deps.clock.now() });
    return { accessToken, refreshToken, expiresIn: this.deps.config.JWT_ACCESS_TTL_SECONDS, user: { id: user.id, email: user.email, fullName: user.full_name, kind: user.kind } };
  }

  /**
   * Refresh rotation with reuse detection: presenting an already-rotated token
   * revokes the whole family (an attacker and the victim both lose the session).
   * The revocation is committed separately so the 401 cannot roll it back.
   */
  async refresh(tenantId: string, refreshToken: string, requestId: string, net?: ClientNet): Promise<TokenPair> {
    const hash = sha256Hex(refreshToken);
    const now = this.deps.clock.now();
    const outcome = await withTenantTx(this.deps.db, tenantId, async (trx) => {
      const session = await trx('auth_sessions').where({ tenant_id: tenantId, refresh_token_hash: hash }).forUpdate().first();
      if (!session) return { kind: 'invalid' as const };
      if (session.revoked_at) return { kind: 'revoked' as const };
      const reuse = { kind: 'reuse' as const, familyId: session.family_id as string, userId: session.user_id as string, sessionId: session.id as string };
      if (session.rotated_at) {
        // A client that lost the response to its own rotation retries with the token it still holds (Wi-Fi drop at
        // the wrong second during a four-hour exam). One retry inside a short window is honoured: the child issued
        // moments ago is revoked and a fresh pair is issued, so whoever holds that child loses it and notices.
        // A second retry, or any presentation after the window, is reuse and the whole family is revoked.
        const withinGrace = now.getTime() - new Date(session.rotated_at).getTime() <= REFRESH_RETRY_GRACE_MS;
        const alreadyRetried = withinGrace ? await trx('auth_sessions').where({ tenant_id: tenantId, parent_id: session.id, revoked_reason: 'superseded_by_retry' }).first('id') : null;
        if (!withinGrace || alreadyRetried) return reuse;
      }
      if (new Date(session.expires_at) < now) return { kind: 'expired' as const };
      const tenantRow = await trx('tenants').where('id', tenantId).first('sessions_revoked_at');
      if (tenantRow?.sessions_revoked_at && new Date(session.issued_at) <= new Date(tenantRow.sessions_revoked_at)) {
        return { kind: 'revoked' as const };
      }
      const user = await trx('users').where({ id: session.user_id, tenant_id: tenantId }).first();
      if (!user || user.status !== 'ACTIVE') return { kind: 'revoked' as const };
      if (session.rotated_at) {
        await trx('auth_sessions').where({ tenant_id: tenantId, parent_id: session.id }).whereNull('revoked_at').update({ revoked_at: trx.fn.now(), revoked_reason: 'superseded_by_retry' });
        await audit(trx, { tenantId, actorType: 'USER', actorId: session.user_id, action: 'auth.refresh_retried', entityType: 'auth_session', entityId: session.id, requestId, metadata: { ip: net?.ip ?? null } });
      }
      await trx('auth_sessions').where('id', session.id).update({ rotated_at: trx.fn.now() });
      return { kind: 'ok' as const, pair: await this.issueTokens(trx, tenantId, user, { familyId: session.family_id, parentId: session.id, fingerprint: session.client_fingerprint ?? undefined, net }) };
    });
    switch (outcome.kind) {
      case 'ok':
        return outcome.pair;
      case 'reuse':
        await withTenantTx(this.deps.db, tenantId, async (trx) => {
          await this.revokeFamily(trx, tenantId, outcome.familyId, 'refresh_token_reuse');
          await audit(trx, { tenantId, actorType: 'USER', actorId: outcome.userId, action: 'auth.refresh_reuse_detected', entityType: 'auth_session', entityId: outcome.sessionId, requestId });
        });
        throw AppError.unauthorized('SESSION_REVOKED', 'Refresh token reuse detected; session revoked');
      case 'expired':
        throw AppError.unauthorized('REFRESH_EXPIRED', 'Refresh token expired');
      case 'revoked':
        throw AppError.unauthorized('SESSION_REVOKED', 'Session revoked');
      default:
        throw AppError.unauthorized('REFRESH_INVALID', 'Invalid refresh token');
    }
  }

  async revokeFamily(trx: Knex.Transaction, tenantId: string, familyId: string, reason: string): Promise<void> {
    await trx('auth_sessions').where({ tenant_id: tenantId, family_id: familyId }).whereNull('revoked_at').update({ revoked_at: trx.fn.now(), revoked_reason: reason });
    // Access tokens already issued stay valid until expiry unless this flag is consulted (requireUser does).
    await this.deps.redis.set(`auth:family-revoked:${familyId}`, '1', 'EX', this.deps.config.JWT_ACCESS_TTL_SECONDS + 60);
  }

  async logout(tenantId: string, familyId: string, userId: string, requestId: string): Promise<void> {
    await withTenantTx(this.deps.db, tenantId, async (trx) => {
      await this.revokeFamily(trx, tenantId, familyId, 'logout');
      await audit(trx, { tenantId, actorType: 'USER', actorId: userId, action: 'auth.logout', entityType: 'user', entityId: userId, requestId });
    });
  }

  /**
   * Always answers the same way, known address or not. Someone who never
   * activated gets a new activation link instead, which is what they need.
   */
  async forgotPassword(tenantId: string, email: string, requestId: string): Promise<void> {
    await withTenantTx(this.deps.db, tenantId, async (trx) => {
      const u = await trx('users').where({ tenant_id: tenantId, email: email.toLowerCase() }).first('id', 'email', 'full_name', 'status');
      if (!u) return;
      const target = { tenantId, userId: u.id as string, email: u.email as string, fullName: u.full_name as string };
      if (u.status === 'ACTIVE') await issuePasswordReset(this.deps, trx, target);
      else if (u.status === 'PENDING_ACTIVATION') await issueActivation(this.deps, trx, target);
      else return;
      await audit(trx, { tenantId, actorType: 'USER', actorId: u.id, action: 'auth.password_reset_requested', entityType: 'user', entityId: u.id, requestId });
    });
  }

  /** Consumes a single-use reset token, clears any lockout and ends every session of the account. */
  async resetPassword(tenantId: string, token: string, password: string, requestId: string): Promise<void> {
    const passwordHash = await this.hashPassword(password);
    await withTenantTx(this.deps.db, tenantId, async (trx) => {
      const rows = await trx('one_time_tokens')
        .where({ tenant_id: tenantId, token_hash: sha256Hex(token), purpose: 'PASSWORD_RESET' })
        .whereNull('consumed_at')
        .where('expires_at', '>', this.deps.clock.now())
        .update({ consumed_at: trx.fn.now() })
        .returning(['user_id']);
      const t = rows[0];
      const user = t ? await trx('users').where({ id: t.user_id, tenant_id: tenantId }).forNoKeyUpdate().first('status') : null;
      if (!t || user?.status !== 'ACTIVE') throw AppError.unauthorized('RESET_INVALID', 'This reset link is invalid, used or expired');
      await trx('users').where({ id: t.user_id, tenant_id: tenantId }).update({ password_hash: passwordHash, failed_login_count: 0, locked_until: null, updated_at: trx.fn.now() });
      const families = await trx('auth_sessions').where({ tenant_id: tenantId, user_id: t.user_id }).whereNull('revoked_at').distinct('family_id');
      for (const f of families) await this.revokeFamily(trx, tenantId, f.family_id, 'password_reset');
      await audit(trx, { tenantId, actorType: 'USER', actorId: t.user_id, action: 'auth.password_reset', entityType: 'user', entityId: t.user_id, requestId });
    });
  }

  /** Consumes a single-use activation token atomically and sets the first password. */
  async activate(tenantId: string, token: string, password: string, requestId: string, net?: ClientNet): Promise<TokenPair> {
    return withTenantTx(this.deps.db, tenantId, async (trx) => {
      const now = this.deps.clock.now();
      const rows = await trx('one_time_tokens')
        .where({ tenant_id: tenantId, token_hash: sha256Hex(token), purpose: 'ACTIVATION' })
        .whereNull('consumed_at')
        .where('expires_at', '>', now)
        .update({ consumed_at: trx.fn.now() })
        .returning(['id', 'user_id']);
      const t = rows[0];
      if (!t) throw AppError.unauthorized('ACTIVATION_INVALID', 'Activation link is invalid, used or expired');
      const current = await trx('users').where({ id: t.user_id, tenant_id: tenantId }).forNoKeyUpdate().first('status');
      if (!current || !['PENDING_ACTIVATION', 'ACTIVE'].includes(current.status)) throw AppError.unauthorized('ACTIVATION_INVALID', 'Activation link is invalid, used or expired');
      if (current.status !== 'ACTIVE') assertTransition('user', USER_TRANSITIONS, current.status, 'ACTIVE');
      const passwordHash = await this.hashPassword(password);
      await trx('users').where({ id: t.user_id, tenant_id: tenantId }).update({ password_hash: passwordHash, status: 'ACTIVE', updated_at: trx.fn.now() });
      const user = await trx('users').where({ id: t.user_id }).first();
      await audit(trx, { tenantId, actorType: 'USER', actorId: t.user_id, action: 'auth.activated', entityType: 'user', entityId: t.user_id, requestId });
      return this.issueTokens(trx, tenantId, user, { familyId: randomUUID(), parentId: null, net });
    });
  }

  async getMfaStatus(tenantId: string, userId: string): Promise<{ enabled: boolean; required: boolean }> {
    return withTenantTx(this.deps.db, tenantId, async (trx) => {
      const user = await trx('users').where({ id: userId, tenant_id: tenantId }).first('totp_enabled');
      const grants = await trx('role_grants').where({ tenant_id: tenantId, user_id: userId }).whereNull('revoked_at').select('role_code');
      const required = grants.some((g) => PRIVILEGED_MFA_ROLES.includes(g.role_code as any));
      return { enabled: Boolean(user?.totp_enabled), required };
    });
  }

  async setupMfa(tenantId: string, userId: string, requestId: string): Promise<{ secret: string; qrUri: string; recoveryCodes: string[] }> {
    return withTenantTx(this.deps.db, tenantId, async (trx) => {
      const user = await trx('users').where({ id: userId, tenant_id: tenantId }).first('email');
      const tenant = await trx('tenants').where('id', tenantId).first('name');
      if (!user) throw AppError.notFound('USER_NOT_FOUND');

      const secret = newTotpSecret();
      const sealedSecret = await this.deps.secrets.seal(secret);
      const recoveryCodes = Array.from({ length: 8 }, () => randomBytes(4).toString('hex').toUpperCase());

      await trx('users').where('id', userId).update({
        totp_secret_ref: sealedSecret,
        recovery_codes: recoveryCodes,
        updated_at: trx.fn.now(),
      });

      const issuer = encodeURIComponent(tenant?.name ?? 'ExamOS');
      const label = encodeURIComponent(user.email);
      const qrUri = `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}&period=30&digits=6`;

      await audit(trx, {
        tenantId,
        actorType: 'USER',
        actorId: userId,
        action: 'auth.mfa_setup_initiated',
        entityType: 'user',
        entityId: userId,
        requestId,
      });

      return { secret, qrUri, recoveryCodes };
    });
  }

  async activateMfa(tenantId: string, userId: string, code: string, requestId: string): Promise<{ success: boolean }> {
    return withTenantTx(this.deps.db, tenantId, async (trx) => {
      const user = await trx('users').where({ id: userId, tenant_id: tenantId }).first();
      if (!user || !user.totp_secret_ref) throw AppError.badRequest('MFA_NOT_INITIALIZED', 'MFA setup has not been initiated');

      const secret = await this.deps.secrets.resolve(user.totp_secret_ref);
      const step = verifyTotp(secret, code, this.deps.clock.now(), -1);
      if (step === null) throw AppError.badRequest('MFA_CODE_INVALID', 'Invalid verification code');

      await trx('users').where('id', userId).update({
        totp_enabled: true,
        totp_last_step: step,
        updated_at: trx.fn.now(),
      });

      await audit(trx, {
        tenantId,
        actorType: 'USER',
        actorId: userId,
        action: 'auth.mfa_activated',
        entityType: 'user',
        entityId: userId,
        requestId,
      });

      return { success: true };
    });
  }

  async disableMfa(tenantId: string, userId: string, code: string, requestId: string): Promise<{ success: boolean }> {
    return withTenantTx(this.deps.db, tenantId, async (trx) => {
      const user = await trx('users').where({ id: userId, tenant_id: tenantId }).first();
      if (!user || !user.totp_enabled || !user.totp_secret_ref) {
        throw AppError.badRequest('MFA_NOT_ENABLED', 'MFA is not enabled');
      }

      const grants = await trx('role_grants').where({ tenant_id: tenantId, user_id: userId }).whereNull('revoked_at').select('role_code');
      const isPrivileged = grants.some((g) => PRIVILEGED_MFA_ROLES.includes(g.role_code as any));
      if (isPrivileged) {
        throw AppError.forbidden('MFA_MANDATORY_FOR_ROLE', 'MFA cannot be disabled for privileged university accounts');
      }

      const secret = await this.deps.secrets.resolve(user.totp_secret_ref);
      const step = verifyTotp(secret, code, this.deps.clock.now(), Number(user.totp_last_step ?? -1));
      if (step === null) throw AppError.badRequest('MFA_CODE_INVALID', 'Invalid authentication code');

      await trx('users').where('id', userId).update({
        totp_enabled: false,
        totp_secret_ref: null,
        recovery_codes: null,
        updated_at: trx.fn.now(),
      });

      await audit(trx, {
        tenantId,
        actorType: 'USER',
        actorId: userId,
        action: 'auth.mfa_disabled',
        entityType: 'user',
        entityId: userId,
        requestId,
      });

      return { success: true };
    });
  }

  async listUserSessions(tenantId: string, userId: string, currentFamilyId: string): Promise<any[]> {
    return withTenantTx(this.deps.db, tenantId, async (trx) => {
      const rows = await trx('auth_sessions')
        .where({ tenant_id: tenantId, user_id: userId })
        .whereNull('revoked_at')
        .where('expires_at', '>', trx.fn.now())
        .orderBy('issued_at', 'desc');

      const seen = new Set<string>();
      const sessions = [];
      for (const r of rows) {
        if (!seen.has(r.family_id)) {
          seen.add(r.family_id);
          sessions.push({
            id: r.id,
            familyId: r.family_id,
            ip: r.ip,
            userAgent: r.user_agent,
            issuedAt: r.issued_at.toISOString(),
            expiresAt: r.expires_at.toISOString(),
            isCurrent: r.family_id === currentFamilyId,
          });
        }
      }
      return sessions;
    });
  }

  async revokeUserSession(tenantId: string, userId: string, sessionId: string, requestId: string): Promise<void> {
    return withTenantTx(this.deps.db, tenantId, async (trx) => {
      const session = await trx('auth_sessions').where({ id: sessionId, tenant_id: tenantId, user_id: userId }).first('family_id');
      if (!session) throw AppError.notFound('SESSION_NOT_FOUND', 'Session not found');
      await this.revokeFamily(trx, tenantId, session.family_id, 'user_self_revocation');
      await audit(trx, {
        tenantId,
        actorType: 'USER',
        actorId: userId,
        action: 'auth.session_revoked',
        entityType: 'auth_session',
        entityId: sessionId,
        requestId,
      });
    });
  }

  async revokeOtherUserSessions(tenantId: string, userId: string, currentFamilyId: string, requestId: string): Promise<void> {
    return withTenantTx(this.deps.db, tenantId, async (trx) => {
      const families = await trx('auth_sessions')
        .where({ tenant_id: tenantId, user_id: userId })
        .whereNot('family_id', currentFamilyId)
        .whereNull('revoked_at')
        .distinct('family_id');

      for (const f of families) {
        await this.revokeFamily(trx, tenantId, f.family_id, 'revoke_other_sessions');
      }

      await audit(trx, {
        tenantId,
        actorType: 'USER',
        actorId: userId,
        action: 'auth.other_sessions_revoked',
        entityType: 'user',
        entityId: userId,
        requestId,
        metadata: { revokedCount: families.length },
      });
    });
  }
}
