import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createHash, randomUUID } from 'node:crypto';
import { withTenantTx } from '@examos/db';
import type { AppDeps } from '../../types.js';
import { AppError } from '../../lib/errors.js';
import { randomToken } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import type { AuthService, TokenPair } from './service.js';

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface SsoConfigRow {
  provider: 'entra' | 'google' | 'generic';
  issuer: string;
  client_id: string;
  client_secret_ref: string | null;
  allowed_email_domains: string[];
  enabled: boolean;
}

/**
 * OpenID Connect authorization-code flow with PKCE for Microsoft Entra ID and
 * Google Workspace (second brief: students mostly hold one of the two). Users
 * are never created just-in-time from an SSO assertion: the ERP roster is the
 * identity authority, so an unknown account is refused with a clear message.
 */
export class OidcService {
  private jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
  constructor(
    private readonly deps: AppDeps,
    private readonly auth: AuthService,
  ) {}

  private async config(tenantId: string): Promise<SsoConfigRow> {
    const row = (await withTenantTx(this.deps.db, tenantId, (trx) => trx('tenant_sso_configs').where({ tenant_id: tenantId }).first())) as SsoConfigRow | undefined;
    if (!row || !row.enabled) throw AppError.notFound('SSO_NOT_CONFIGURED', 'Single sign-on is not enabled for this tenant');
    return row;
  }

  private async discovery(issuer: string): Promise<Discovery> {
    const key = `oidc:discovery:${issuer}`;
    const cached = await this.deps.redis.get(key);
    if (cached) return JSON.parse(cached) as Discovery;
    const url = issuer.replace(/\/$/, '') + '/.well-known/openid-configuration';
    const res = await this.deps.fetch(url);
    if (!res.ok) throw new AppError(502, 'OIDC_DISCOVERY_FAILED', `Discovery failed with ${res.status}`);
    const doc = (await res.json()) as Discovery;
    await this.deps.redis.set(key, JSON.stringify(doc), 'EX', 3600);
    return doc;
  }

  async start(tenantId: string, redirectUri: string): Promise<{ authorizationUrl: string; state: string }> {
    const cfg = await this.config(tenantId);
    const disc = await this.discovery(cfg.issuer);
    const state = randomToken(24);
    const nonce = randomToken(24);
    const verifier = randomToken(48);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    await this.deps.redis.set(`oidc:state:${state}`, JSON.stringify({ tenantId, nonce, verifier, redirectUri }), 'EX', 600);
    const params = new URLSearchParams({
      client_id: cfg.client_id,
      response_type: 'code',
      scope: 'openid profile email',
      redirect_uri: redirectUri,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return { authorizationUrl: `${disc.authorization_endpoint}?${params.toString()}`, state };
  }

  async callback(tenantId: string, code: string, state: string, requestId: string): Promise<TokenPair> {
    const raw = await this.deps.redis.getdel(`oidc:state:${state}`);
    if (!raw) throw AppError.unauthorized('OIDC_STATE_INVALID', 'Login session expired or state mismatch');
    const st = JSON.parse(raw) as { tenantId: string; nonce: string; verifier: string; redirectUri: string };
    if (st.tenantId !== tenantId) throw AppError.unauthorized('OIDC_STATE_INVALID', 'State belongs to another tenant');

    const cfg = await this.config(tenantId);
    const disc = await this.discovery(cfg.issuer);
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: st.redirectUri, client_id: cfg.client_id, code_verifier: st.verifier });
    if (cfg.client_secret_ref) form.set('client_secret', await this.deps.secrets.resolve(cfg.client_secret_ref));
    const tokenRes = await this.deps.fetch(disc.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
    if (!tokenRes.ok) throw AppError.unauthorized('OIDC_EXCHANGE_FAILED', `Identity provider rejected the code (${tokenRes.status})`);
    const tokens = (await tokenRes.json()) as { id_token?: string };
    if (!tokens.id_token) throw AppError.unauthorized('OIDC_EXCHANGE_FAILED', 'No id_token in response');

    let jwks = this.jwksCache.get(disc.jwks_uri);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(disc.jwks_uri));
      this.jwksCache.set(disc.jwks_uri, jwks);
    }
    let payload;
    try {
      ({ payload } = await jwtVerify(tokens.id_token, jwks, { issuer: disc.issuer, audience: cfg.client_id, clockTolerance: 60 }));
    } catch {
      throw AppError.unauthorized('OIDC_TOKEN_INVALID', 'id_token signature or claims invalid');
    }
    if (payload['nonce'] !== st.nonce) throw AppError.unauthorized('OIDC_NONCE_MISMATCH', 'nonce mismatch');
    const subject = typeof payload['oid'] === 'string' ? (payload['oid'] as string) : payload.sub;
    const email = String(payload['email'] ?? payload['preferred_username'] ?? '').toLowerCase();
    if (!subject) throw AppError.unauthorized('OIDC_TOKEN_INVALID', 'id_token has no subject');

    return withTenantTx(this.deps.db, tenantId, async (trx) => {
      const provider = `oidc:${cfg.provider}`;
      let user = await trx('users as u')
        .join('external_identities as x', 'x.user_id', 'u.id')
        .where({ 'x.tenant_id': tenantId, 'x.provider': provider, 'x.external_id': subject })
        .select('u.*')
        .first();
      if (!user) {
        const domain = email.split('@')[1] ?? '';
        if (!email || (cfg.allowed_email_domains.length > 0 && !cfg.allowed_email_domains.includes(domain))) {
          throw AppError.forbidden('SSO_ACCOUNT_NOT_ALLOWED', 'This account is not permitted for this tenant');
        }
        user = await trx('users').where({ tenant_id: tenantId, email }).first();
        if (!user) throw AppError.forbidden('SSO_ACCOUNT_UNKNOWN', 'No ExamOS account exists for this identity; contact the Examination Section');
        await trx('external_identities').insert({ tenant_id: tenantId, user_id: user.id, provider, external_id: subject, attributes: JSON.stringify({ email }) });
      }
      if (user.status === 'PENDING_ACTIVATION') {
        await trx('users').where('id', user.id).update({ status: 'ACTIVE', updated_at: trx.fn.now() });
        user.status = 'ACTIVE';
      }
      if (user.status !== 'ACTIVE') throw AppError.forbidden('ACCOUNT_INACTIVE', 'Account is not active');
      await trx('users').where('id', user.id).update({ last_login_at: trx.fn.now() });
      await audit(trx, { tenantId, actorType: 'USER', actorId: user.id, action: 'auth.sso_login', entityType: 'user', entityId: user.id, requestId, metadata: { provider: cfg.provider } });
      return this.auth.issueTokens(trx, tenantId, user, { familyId: randomUUID(), parentId: null });
    });
  }
}
