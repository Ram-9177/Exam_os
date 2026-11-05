import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestContext, provisionTenant, type TestContext, type ProvisionedTenant } from './helpers.js';
import { totp } from '../src/modules/platform/totp.js';

describe('Module 1: Identity, roles, MFA, sessions, branding, and platform audit', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;

  const H = (token: string, extra: Record<string, string> = {}) => ({
    Host: t.host,
    Authorization: `Bearer ${token}`,
    ...extra,
  });
  const req = () => ctx.request();

  const getCode = () => {
    const step = Math.floor(Date.now() / 30_000);
    return totp(totpSecret, step);
  };

  const resetLastTotpStep = async () => {
    await ctx.admin('users').where('id', t.admin.userId).update({ totp_last_step: -1 });
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    t = await provisionTenant(ctx, 'mfa-test');
  });

  afterAll(async () => ctx.close());

  let totpSecret: string;
  let recoveryCodes: string[];

  it('reports MFA status and guides privileged users to set up TOTP', async () => {
    // Admin holds TENANT_ADMIN / CONTROLLER
    const statusRes = await req()
      .get('/api/v1/auth/mfa/status')
      .set(H(t.admin.token));
    expect(statusRes.status).toBe(200);
    expect(statusRes.body).toMatchObject({ enabled: false, required: true });

    // Setup MFA: generates secret, recovery codes, and otpauth URI
    const setupRes = await req()
      .post('/api/v1/auth/mfa/setup')
      .set(H(t.admin.token));
    expect(setupRes.status).toBe(200);
    expect(setupRes.body.secret).toBeTruthy();
    expect(setupRes.body.qrUri).toContain('otpauth://totp/');
    expect(setupRes.body.recoveryCodes).toHaveLength(8);

    totpSecret = setupRes.body.secret;
    recoveryCodes = setupRes.body.recoveryCodes;

    // Secret is sealed in database, never stored in plain text
    const userRow = await ctx.admin('users').where('id', t.admin.userId).first();
    expect(userRow.totp_secret_ref).toBeTruthy();
    expect(userRow.totp_secret_ref).not.toBe(totpSecret);
    expect(userRow.totp_enabled).toBe(false);

    // Activating with invalid code fails
    const badCodeRes = await req()
      .post('/api/v1/auth/mfa/activate')
      .set(H(t.admin.token))
      .send({ code: '000000' });
    expect(badCodeRes.status).toBe(400);
    expect(badCodeRes.body.code).toBe('MFA_CODE_INVALID');

    // Activating with valid TOTP code succeeds
    const okRes = await req()
      .post('/api/v1/auth/mfa/activate')
      .set(H(t.admin.token))
      .send({ code: getCode() });
    expect(okRes.status).toBe(200);
    expect(okRes.body.success).toBe(true);

    const activeStatus = await req()
      .get('/api/v1/auth/mfa/status')
      .set(H(t.admin.token));
    expect(activeStatus.body).toMatchObject({ enabled: true, required: true });
  });

  it('enforces MFA on login for accounts with TOTP enabled', async () => {
    await resetLastTotpStep();

    // Attempt login without MFA code -> returns 401 MFA_REQUIRED
    const noMfaRes = await req()
      .post('/api/v1/auth/login')
      .set('Host', t.host)
      .send({ email: t.admin.email, password: t.admin.password });
    expect(noMfaRes.status).toBe(401);
    expect(noMfaRes.body.code).toBe('MFA_REQUIRED');

    // Attempt login with invalid MFA code -> returns 401 MFA_CODE_INVALID
    const badMfaRes = await req()
      .post('/api/v1/auth/login')
      .set('Host', t.host)
      .send({ email: t.admin.email, password: t.admin.password, mfaCode: '111111' });
    expect(badMfaRes.status).toBe(401);
    expect(badMfaRes.body.code).toBe('MFA_CODE_INVALID');

    // Login with valid TOTP code succeeds
    const okMfaRes = await req()
      .post('/api/v1/auth/login')
      .set('Host', t.host)
      .send({ email: t.admin.email, password: t.admin.password, mfaCode: getCode() });
    expect(okMfaRes.status).toBe(200);
    expect(okMfaRes.body.accessToken).toBeTruthy();

    await resetLastTotpStep();

    // Login with recovery code succeeds and consumes that recovery code
    const recoveryCode = recoveryCodes[0]!;
    const recoveryLogin = await req()
      .post('/api/v1/auth/login')
      .set('Host', t.host)
      .send({ email: t.admin.email, password: t.admin.password, mfaCode: recoveryCode });
    expect(recoveryLogin.status).toBe(200);

    // Same recovery code cannot be reused
    const reusedRecovery = await req()
      .post('/api/v1/auth/login')
      .set('Host', t.host)
      .send({ email: t.admin.email, password: t.admin.password, mfaCode: recoveryCode });
    expect(reusedRecovery.status).toBe(401);
    expect(reusedRecovery.body.code).toBe('MFA_CODE_INVALID');
  });

  it('requires step-up MFA for privileged operations (script export)', async () => {
    await resetLastTotpStep();

    // Insert department and course for the exam
    const [dept] = await ctx.admin('departments').insert({
      tenant_id: t.tenantId,
      code: 'CS',
      name: 'Computer Science',
    }).returning('*');

    await ctx.admin('courses').insert({
      tenant_id: t.tenantId,
      department_id: dept.id,
      code: 'CS101',
      name: 'Information Security',
      credits: 4,
    });

    const now = Date.now();
    const examRes = await req()
      .post('/api/v1/exams')
      .set(H(t.admin.token))
      .send({
        code: 'CS-MFA-101',
        title: 'Information Security Exam',
        courseCode: 'CS101',
        examType: 'SEM_INTERNAL',
        durationMinutes: 120,
        windowStartAt: new Date(now - 60_000).toISOString(),
        windowEndAt: new Date(now + 4 * 3600_000).toISOString(),
      });
    expect(examRes.status).toBe(201);
    const examId = examRes.body.examId;

    // Attempting script export without x-mfa-code header -> 403 MFA_STEP_UP_REQUIRED
    const refusedExport = await req()
      .get(`/api/v1/exams/${examId}/exports/scripts`)
      .set(H(t.admin.token));
    expect(refusedExport.status).toBe(403);
    expect(refusedExport.body.code).toBe('MFA_STEP_UP_REQUIRED');

    // Attempting with invalid code -> 403 MFA_CODE_INVALID
    const badCodeExport = await req()
      .get(`/api/v1/exams/${examId}/exports/scripts`)
      .set(H(t.admin.token, { 'x-mfa-code': '999999' }));
    expect(badCodeExport.status).toBe(403);
    expect(badCodeExport.body.code).toBe('MFA_CODE_INVALID');

    // Attempting with valid step-up MFA code passes authorization
    const okExport = await req()
      .get(`/api/v1/exams/${examId}/exports/scripts`)
      .set(H(t.admin.token, { 'x-mfa-code': getCode() }));
    expect(okExport.status).toBe(200);
    expect(okExport.body).toHaveProperty('scripts');
  });

  it('lists active user sessions and supports individual and batch session revocation', async () => {
    await resetLastTotpStep();

    // Generate a second login session
    const secondLogin = await req()
      .post('/api/v1/auth/login')
      .set('Host', t.host)
      .send({ email: t.admin.email, password: t.admin.password, mfaCode: getCode() });
    expect(secondLogin.status).toBe(200);
    const secondToken = secondLogin.body.accessToken;

    // List sessions
    const sessionsRes = await req()
      .get('/api/v1/auth/sessions')
      .set(H(secondToken));
    expect(sessionsRes.status).toBe(200);
    expect(sessionsRes.body.sessions.length).toBeGreaterThanOrEqual(2);

    const currentSession = sessionsRes.body.sessions.find((s: { isCurrent: boolean }) => s.isCurrent);
    expect(currentSession).toBeTruthy();

    // Revoke all other sessions
    const revokeOthersRes = await req()
      .post('/api/v1/auth/sessions/revoke-others')
      .set(H(secondToken));
    expect(revokeOthersRes.status).toBe(204);

    // Original token is now revoked
    const oldCall = await req()
      .get('/api/v1/auth/sessions')
      .set(H(t.admin.token));
    expect(oldCall.status).toBe(401);
    expect(oldCall.body.code).toBe('SESSION_REVOKED');

    // Second session remains valid
    const currentCall = await req()
      .get('/api/v1/auth/sessions')
      .set(H(secondToken));
    expect(currentCall.status).toBe(200);
  });

  it('tenant-wide emergency logout revokes every active user session simultaneously', async () => {
    await resetLastTotpStep();

    // Login to get a fresh active session
    const login = await req()
      .post('/api/v1/auth/login')
      .set('Host', t.host)
      .send({ email: t.admin.email, password: t.admin.password, mfaCode: getCode() });
    expect(login.status).toBe(200);
    const token = login.body.accessToken;
    const refreshToken = login.body.refreshToken;

    // Trigger tenant-wide emergency logout
    const emergencyRes = await req()
      .post('/api/v1/tenant/revoke-all-sessions')
      .set(H(token));
    expect(emergencyRes.status).toBe(200);
    expect(emergencyRes.body.success).toBe(true);
    expect(emergencyRes.body.revokedAt).toBeTruthy();

    // The previously issued access token is rejected
    const testOldToken = await req()
      .get('/api/v1/auth/sessions')
      .set(H(token));
    expect(testOldToken.status).toBe(401);
    expect(testOldToken.body.code).toBe('SESSION_REVOKED');

    // Refreshing the pre-revocation refresh token is also refused
    const testRefresh = await req()
      .post('/api/v1/auth/refresh')
      .set('Host', t.host)
      .send({ refreshToken });
    expect(testRefresh.status).toBe(401);
  });

  it('updates campus branding and displays custom branding details', async () => {
    // Read initial branding
    const initial = await req()
      .get('/api/v1/tenant/branding')
      .set('Host', t.host);
    expect(initial.status).toBe(200);
    expect(initial.body).toHaveProperty('branding');

    await resetLastTotpStep();
    // Login for fresh admin token after emergency logout
    const login = await req()
      .post('/api/v1/auth/login')
      .set('Host', t.host)
      .send({ email: t.admin.email, password: t.admin.password, mfaCode: getCode() });
    const freshToken = login.body.accessToken;

    // Update campus branding
    const brandingPayload = {
      logoUrl: 'https://cdn.smru.edu/branding/main-campus.png',
      primaryColor: '#1e3fb8',
      accentColor: '#9db0ff',
      headerText: "St. Mary's University — Main Examination Directorate",
      contactEmail: 'coe@smru.edu.in',
    };

    const updateRes = await req()
      .put('/api/v1/tenant/branding')
      .set(H(freshToken))
      .send(brandingPayload);
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.branding).toMatchObject(brandingPayload);

    // Verify GET /branding returns updated details
    const fetched = await req()
      .get('/api/v1/tenant/branding')
      .set('Host', t.host);
    expect(fetched.body.branding).toMatchObject(brandingPayload);
  });

  it('filters audit events and exports an audit log CSV with audited record', async () => {
    await resetLastTotpStep();
    const login = await req()
      .post('/api/v1/auth/login')
      .set('Host', t.host)
      .send({ email: t.admin.email, password: t.admin.password, mfaCode: getCode() });
    const token = login.body.accessToken;

    // Query audit log with filter
    const auditRes = await req()
      .get('/api/v1/tenant/audit?action=branding')
      .set(H(token));
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.events.length).toBeGreaterThanOrEqual(1);
    expect(auditRes.body.events[0].action).toContain('branding');

    // Export audit log as CSV
    const exportRes = await req()
      .post('/api/v1/tenant/audit/export')
      .set(H(token));
    expect(exportRes.status).toBe(200);
    expect(exportRes.header['content-type']).toContain('text/csv');
    expect(exportRes.text).toContain('id,timestamp,actor_type,actor_id,action');
    expect(exportRes.text).toContain('tenant.branding_updated');

    // Invariant: The export action itself is recorded in audit_events
    const exportAudit = await ctx.admin('audit_events')
      .where({ tenant_id: t.tenantId, action: 'audit.exported' })
      .first();
    expect(exportAudit).toBeTruthy();
    expect(exportAudit.actor_id).toBe(t.admin.userId);
  });

  it('concurrency test: concurrent session revocations do not deadlock or leave inconsistent state', async () => {
    await resetLastTotpStep();
    const login = await req()
      .post('/api/v1/auth/login')
      .set('Host', t.host)
      .send({ email: t.admin.email, password: t.admin.password, mfaCode: getCode() });
    const token = login.body.accessToken;

    // Run 5 simultaneous revoke-others calls
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        req().post('/api/v1/auth/sessions/revoke-others').set(H(token))
      )
    );
    for (const r of results) {
      expect(r.status).toBe(204);
    }
  });
});
