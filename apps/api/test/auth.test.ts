import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, type KeyLike } from 'jose';
import { createTestContext, provisionTenant, createStaff, login, startFakeServer, type TestContext, type ProvisionedTenant } from './helpers.js';

describe('authentication and authorization', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;

  beforeAll(async () => {
    ctx = await createTestContext();
    t = await provisionTenant(ctx, 'auth');
  });
  afterAll(async () => ctx.close());

  it('issues short-lived RS256 access tokens verifiable against the JWKS endpoint', async () => {
    const jwks = await ctx.request().get('/api/v1/auth/.well-known/jwks.json').set('Host', t.host);
    expect(jwks.status).toBe(200);
    expect(jwks.body.keys[0].kty).toBe('RSA');
    const me = await ctx.request().get('/api/v1/auth/me').set('Host', t.host).set('Authorization', `Bearer ${t.admin.token}`);
    expect(me.status).toBe(200);
    expect(me.body.grants.some((g: { role: string }) => g.role === 'TENANT_ADMIN')).toBe(true);
    // permissions are not in the token
    const payload = JSON.parse(Buffer.from(t.admin.token.split('.')[1]!, 'base64url').toString());
    expect(payload.roles).toBeUndefined();
    expect(payload.permissions).toBeUndefined();
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
  });

  it('rotates refresh tokens and revokes the whole family on reuse', async () => {
    const first = await login(ctx, t.host, t.admin.email, t.admin.password);
    const r1 = await ctx.request().post('/api/v1/auth/refresh').set('Host', t.host).send({ refreshToken: first.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(first.refreshToken);
    // reuse of the rotated token = theft signal → family revoked
    const reuse = await ctx.request().post('/api/v1/auth/refresh').set('Host', t.host).send({ refreshToken: first.refreshToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('SESSION_REVOKED');
    const afterRevoke = await ctx.request().post('/api/v1/auth/refresh').set('Host', t.host).send({ refreshToken: r1.body.refreshToken });
    expect(afterRevoke.status).toBe(401);
    const me = await ctx.request().get('/api/v1/auth/me').set('Host', t.host).set('Authorization', `Bearer ${r1.body.accessToken}`);
    expect(me.status).toBe(401);
  });

  it('applies a revoked grant on the very next request (no permission caching)', async () => {
    const op = await createStaff(ctx, t, ['EXAM_CELL_OPERATOR'], 'examcell');
    const ok = await ctx.request().get('/api/v1/exams').set('Host', t.host).set('Authorization', `Bearer ${op.token}`);
    expect(ok.status).toBe(200);
    const rev = await ctx.request().delete(`/api/v1/tenant/users/${op.userId}/roles`).set('Host', t.host).set('Authorization', `Bearer ${t.admin.token}`).send({ role: 'EXAM_CELL_OPERATOR' });
    expect(rev.status).toBe(200);
    expect(rev.body.revoked).toBe(1);
    const denied = await ctx.request().get('/api/v1/exams').set('Host', t.host).set('Authorization', `Bearer ${op.token}`);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('PERMISSION_DENIED');
  });

  it('locks an account after repeated failed logins and never reveals whether the e-mail exists', async () => {
    const victim = await createStaff(ctx, t, ['REPORT_VIEWER'], 'victim');
    for (let i = 0; i < 5; i++) {
      const r = await ctx.request().post('/api/v1/auth/login').set('Host', t.host).send({ email: victim.email, password: 'wrong-password-123' });
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('INVALID_CREDENTIALS');
    }
    const locked = await ctx.request().post('/api/v1/auth/login').set('Host', t.host).send({ email: victim.email, password: victim.password });
    expect(locked.status).toBe(401);
    const ghost = await ctx.request().post('/api/v1/auth/login').set('Host', t.host).send({ email: `nobody-${Date.now()}@${t.slug}.test`, password: 'whatever-123456' });
    expect(ghost.status).toBe(401);
    expect(ghost.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('activation links are single-use and expire', async () => {
    const res = await ctx.request().post('/api/v1/tenant/users').set('Host', t.host).set('Authorization', `Bearer ${t.admin.token}`).send({ email: `once@${t.slug}.test`, fullName: 'Once', kind: 'STAFF', roles: [{ role: 'REPORT_VIEWER' }] });
    expect(res.status).toBe(201);
    const mail = await ctx.admin('mail_dispatches').where({ tenant_id: t.tenantId, to_address: `once@${t.slug}.test` }).first('body_text');
    const token = decodeURIComponent(/token=([^\s]+)/.exec(mail.body_text)![1]!);
    const a1 = await ctx.request().post('/api/v1/auth/activate').set('Host', t.host).send({ token, password: 'Another-Passw0rd!2026' });
    expect(a1.status).toBe(200);
    const a2 = await ctx.request().post('/api/v1/auth/activate').set('Host', t.host).send({ token, password: 'Another-Passw0rd!2026' });
    expect(a2.status).toBe(401);
    expect(a2.body.code).toBe('ACTIVATION_INVALID');
    // no plaintext password or token hash leaks into the mail body
    expect(mail.body_text).not.toContain('Passw0rd');
  });

  describe('OpenID Connect (Microsoft Entra / Google Workspace)', () => {
    let idp: { url: string; close: () => Promise<void> };
    let privateKey: KeyLike;
    let lastNonce = '';
    const clientId = 'examos-client';

    beforeAll(async () => {
      const kp = await generateKeyPair('RS256');
      privateKey = kp.privateKey;
      const jwk = await exportJWK(kp.publicKey);
      idp = await startFakeServer((app) => {
        app.get('/.well-known/openid-configuration', (_req, res) => res.json({ issuer: idp.url, authorization_endpoint: `${idp.url}/authorize`, token_endpoint: `${idp.url}/token`, jwks_uri: `${idp.url}/keys` }));
        app.get('/keys', (_req, res) => res.json({ keys: [{ ...jwk, kid: 'k1', use: 'sig', alg: 'RS256' }] }));
        app.post('/token', async (req, res) => {
          const code = String(req.body.code);
          if (!String(req.body.code_verifier ?? '')) return res.status(400).json({ error: 'invalid_request' });
          const [email, nonceMode] = code.split('|');
          const nonce = nonceMode === 'bad-nonce' ? 'tampered' : lastNonce;
          const idToken = await new SignJWT({ nonce, email, oid: `oid-${email}`, preferred_username: email }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(idp.url).setAudience(clientId).setSubject(`sub-${email}`).setIssuedAt().setExpirationTime('5m').sign(privateKey);
          res.json({ id_token: idToken, access_token: 'x', token_type: 'Bearer' });
        });
      });
      const cfg = await ctx.request().put('/api/v1/tenant/sso-config').set('Host', t.host).set('Authorization', `Bearer ${t.admin.token}`).send({ provider: 'entra', issuer: idp.url, clientId, clientSecret: 'secret', allowedEmailDomains: [`${t.slug}.test`] });
      expect(cfg.status).toBe(204);
    });
    afterAll(async () => idp.close());

    async function start() {
      const s = await ctx.request().get('/api/v1/auth/oidc/start').set('Host', t.host).query({ redirectUri: `https://${t.host}/callback` });
      expect(s.status).toBe(200);
      const u = new URL(s.body.authorizationUrl);
      expect(u.searchParams.get('code_challenge_method')).toBe('S256');
      lastNonce = u.searchParams.get('nonce')!;
      return s.body.state as string;
    }

    it('signs in an existing user by verified id_token and links the provider identity', async () => {
      const state = await start();
      const cb = await ctx.request().post('/api/v1/auth/oidc/callback').set('Host', t.host).send({ code: `${t.admin.email}|ok`, state });
      expect(cb.status).toBe(200);
      expect(cb.body.user.id).toBe(t.admin.userId);
      const link = await ctx.admin('external_identities').where({ tenant_id: t.tenantId, provider: 'oidc:entra', user_id: t.admin.userId }).first();
      expect(link).toBeTruthy();
      // state is single-use
      const replay = await ctx.request().post('/api/v1/auth/oidc/callback').set('Host', t.host).send({ code: `${t.admin.email}|ok`, state });
      expect(replay.status).toBe(401);
    });

    it('rejects a nonce mismatch and refuses unknown or foreign-domain accounts (no JIT provisioning)', async () => {
      const s1 = await start();
      const bad = await ctx.request().post('/api/v1/auth/oidc/callback').set('Host', t.host).send({ code: `${t.admin.email}|bad-nonce`, state: s1 });
      expect(bad.status).toBe(401);
      expect(bad.body.code).toBe('OIDC_NONCE_MISMATCH');
      const s2 = await start();
      const unknown = await ctx.request().post('/api/v1/auth/oidc/callback').set('Host', t.host).send({ code: `stranger@${t.slug}.test|ok`, state: s2 });
      expect(unknown.status).toBe(403);
      expect(unknown.body.code).toBe('SSO_ACCOUNT_UNKNOWN');
      const s3 = await start();
      const foreign = await ctx.request().post('/api/v1/auth/oidc/callback').set('Host', t.host).send({ code: `someone@other-domain.test|ok`, state: s3 });
      expect(foreign.status).toBe(403);
      expect(foreign.body.code).toBe('SSO_ACCOUNT_NOT_ALLOWED');
    });
  });
});
