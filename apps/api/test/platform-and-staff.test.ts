import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { createTestContext, provisionTenant, activationTokenFor, type TestContext, type ProvisionedTenant } from './helpers.js';
import { newTotpSecret, totp } from '../src/modules/platform/totp.js';

/**
 * The account model: one platform super admin for the whole deployment
 * (password + TOTP, sessions bound to the platform tenant), and per tenant at
 * most three or four named staff logins that carry every staff duty through
 * role bundles — everyone else is a student. The cap is enforced by the
 * service, by the database trigger and by the platform settings endpoint.
 */
describe('one super admin; 3–4 staff logins per tenant; everyone else a student', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;
  const PLATFORM = '/api/v1/platform';
  const PASSWORD = 'Platform-Admin-Passw0rd!';
  const secret = newTotpSecret();
  const email = 'it-head@smru.test';
  const code = (offsetSteps = 0) => totp(secret, Math.floor(Date.now() / 30_000) + offsetSteps);
  const H = (token: string) => ({ Host: t.host, Authorization: `Bearer ${token}` });
  const req = () => ctx.request();

  beforeAll(async () => {
    ctx = await createTestContext();
    t = await provisionTenant(ctx, 'acct');
    // Same statement the create-platform-admin script runs: sealed TOTP secret, bcrypt password, singleton row.
    await ctx.admin('platform_admins').insert({ email, password_hash: await bcrypt.hash(PASSWORD, 10), totp_secret_ref: ctx.deps.secrets.seal(secret) });
  });
  afterAll(async () => ctx.close());

  it('there can be only one super admin; login needs the password and a fresh authenticator code', async () => {
    await expect(ctx.admin('platform_admins').insert({ email: 'second@smru.test', password_hash: 'x', totp_secret_ref: 'env:NOPE' })).rejects.toThrow(/singleton|unique|duplicate/i);

    const wrongPassword = await req().post(`${PLATFORM}/auth/login`).set('Host', t.host).send({ email, password: 'Not-The-Password-123!', otp: code() });
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.code).toBe('LOGIN_FAILED');
    const wrongOtp = await req().post(`${PLATFORM}/auth/login`).set('Host', t.host).send({ email, password: PASSWORD, otp: '000000' });
    expect(wrongOtp.status).toBe(401);

    const otp = code();
    const ok = await req().post(`${PLATFORM}/auth/login`).set('Host', t.host).send({ email, password: PASSWORD, otp });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
    expect(ok.body.email).toBe(email);
    // a captured code cannot be replayed, even inside its 30-second window
    const replay = await req().post(`${PLATFORM}/auth/login`).set('Host', t.host).send({ email, password: PASSWORD, otp });
    expect(replay.status).toBe(401);

    const token = ok.body.accessToken as string;
    const tenants = await req().get(`${PLATFORM}/tenants`).set(H(token));
    expect(tenants.status).toBe(200);
    expect(tenants.body.tenants.find((x: { id: string }) => x.id === t.tenantId)).toMatchObject({ slug: t.slug, staffLoginLimit: 4 });
    // a tenant login is never a platform login
    const tenantToken = await req().get(`${PLATFORM}/tenants`).set(H(t.admin.token));
    expect(tenantToken.status).toBe(403);
    expect(tenantToken.body.code).toBe('PLATFORM_ACCESS_REQUIRED');
    const nothing = await req().get(`${PLATFORM}/tenants`).set('Host', t.host);
    expect(nothing.status).toBe(401);

    const sessions = await ctx.admin('platform_sessions').where({ admin_id: (await ctx.admin('platform_admins').first('id')).id });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].ip).toBeTruthy();
    const out = await req().post(`${PLATFORM}/auth/logout`).set(H(token));
    expect(out.status).toBeLessThan(300);
    expect((await req().get(`${PLATFORM}/tenants`).set(H(token))).status).toBe(401);
  });

  it('a tenant holds at most four staff logins carrying every duty through bundles; the fifth is refused by the service and by the database', async () => {
    const create = (body: Record<string, unknown>) => req().post('/api/v1/tenant/users').set(H(t.admin.token)).send(body);
    const seats0 = await req().get('/api/v1/tenant/staff-seats').set(H(t.admin.token));
    expect(seats0.status).toBe(200);
    expect(seats0.body).toMatchObject({ limit: 4, used: 1, free: 3 }); // the tenant admin created at provisioning

    const office = await create({ email: `office@${t.slug}.test`, fullName: 'Exam Office', kind: 'STAFF', bundle: 'EXAM_OFFICE', roles: [] });
    expect(office.status).toBe(201);
    const reviewer = await create({ email: `chief@${t.slug}.test`, fullName: 'Chief Reviewer', kind: 'STAFF', bundle: 'CHIEF_REVIEWER', roles: [] });
    expect(reviewer.status).toBe(201);
    const examiner = await create({ email: `examiner@${t.slug}.test`, fullName: 'Examiner', kind: 'STAFF', bundle: 'EXAMINER', roles: [{ role: 'HOD', scopeType: 'TENANT' }] });
    expect(examiner.status).toBe(201);
    // pending activations hold a seat too; this one activates so it can be parked and asked back later
    const act = await req().post('/api/v1/auth/activate').set('Host', t.host).send({ token: await activationTokenFor(ctx, t.tenantId, `examiner@${t.slug}.test`), password: 'Examiner-Passw0rd!2026' });
    expect(act.status).toBe(200);

    const fifth = await create({ email: `fifth@${t.slug}.test`, fullName: 'One Too Many', kind: 'STAFF', roles: [{ role: 'REPORT_VIEWER' }] });
    expect(fifth.status).toBe(409);
    expect(fifth.body.code).toBe('STAFF_LOGIN_LIMIT');
    // the database refuses even a direct insert that bypasses the service
    await expect(ctx.admin('users').insert({ tenant_id: t.tenantId, email: `direct@${t.slug}.test`, full_name: 'Direct', kind: 'STAFF', status: 'ACTIVE' })).rejects.toThrow(/STAFF_LOGIN_LIMIT/);

    const seats = await req().get('/api/v1/tenant/staff-seats').set(H(t.admin.token));
    expect(seats.body).toMatchObject({ limit: 4, used: 4, free: 0 });
    const byEmail = new Map((seats.body.staff as Array<{ email: string; roles: Array<{ role: string }> }>).map((s) => [s.email, s.roles.map((r) => r.role).sort()]));
    expect(byEmail.get(`office@${t.slug}.test`)).toEqual(['EXAM_CELL_OPERATOR', 'QUESTION_SETTER']);
    expect(byEmail.get(`chief@${t.slug}.test`)).toEqual(['CHIEF_PROCTOR', 'PAPER_REVIEWER']);
    expect(byEmail.get(`examiner@${t.slug}.test`)).toEqual(['EVALUATOR', 'HOD', 'MODERATOR']);
    expect(seats.body.bundles).toMatchObject({ ADMIN_CONTROLLER: expect.any(Array), EXAM_OFFICE: expect.any(Array) });

    // students are not seats
    for (const n of [1, 2, 3]) {
      const s = await create({ email: `student${n}@${t.slug}.test`, fullName: `Student ${n}`, kind: 'STUDENT', roles: [] });
      expect(s.status).toBe(201);
    }
    const asStaffRole = await create({ email: `student9@${t.slug}.test`, fullName: 'Student Nine', kind: 'STUDENT', roles: [{ role: 'EVALUATOR' }] });
    expect(asStaffRole.status).toBe(422);
    expect(asStaffRole.body.code).toBe('ROLE_KIND_MISMATCH');

    // a seat is freed by deactivating its holder, and a deactivated holder cannot return while the tenant is full
    const parked = await req().patch(`/api/v1/tenant/users/${examiner.body.userId}/status`).set(H(t.admin.token)).send({ status: 'INACTIVE', reason: 'left the university' });
    expect(parked.status).toBe(200);
    const replacement = await create({ email: `fifth@${t.slug}.test`, fullName: 'Replacement Examiner', kind: 'STAFF', bundle: 'EXAMINER', roles: [] });
    expect(replacement.status).toBe(201);
    const back = await req().patch(`/api/v1/tenant/users/${examiner.body.userId}/status`).set(H(t.admin.token)).send({ status: 'ACTIVE' });
    expect(back.status).toBe(409);
    expect(back.body.code).toBe('STAFF_LOGIN_LIMIT');

    // the admin cannot change their own roles or status
    const self = await req().delete(`/api/v1/tenant/users/${t.admin.userId}/roles`).set(H(t.admin.token)).send({ role: 'TENANT_ADMIN' });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SELF_ROLE_CHANGE_FORBIDDEN');
  });

  it('only the super admin sets the limit (3 or 4) and cannot set it below current use', async () => {
    const login = await req().post(`${PLATFORM}/auth/login`).set('Host', t.host).send({ email, password: PASSWORD, otp: code(1) });
    expect(login.status).toBe(200);
    const P = H(login.body.accessToken);
    const tooLow = await req().patch(`${PLATFORM}/tenants/${t.tenantId}`).set(P).send({ staffLoginLimit: 3 });
    expect(tooLow.status).toBe(409);
    expect(tooLow.body.code).toBe('STAFF_LIMIT_BELOW_USAGE');
    const five = await req().patch(`${PLATFORM}/tenants/${t.tenantId}`).set(P).send({ staffLoginLimit: 5 });
    expect(five.status).toBe(400);
    const notAdmin = await req().patch(`${PLATFORM}/tenants/${t.tenantId}`).set(H(t.admin.token)).send({ staffLoginLimit: 3 });
    expect(notAdmin.status).toBe(403);

    const staff = await ctx.admin('users').where({ tenant_id: t.tenantId, kind: 'STAFF' }).whereIn('status', ['ACTIVE', 'PENDING_ACTIVATION']).whereNot('id', t.admin.userId).first('id');
    await req().patch(`/api/v1/tenant/users/${staff.id}/status`).set(H(t.admin.token)).send({ status: 'INACTIVE', reason: 'seat released' });
    const lowered = await req().patch(`${PLATFORM}/tenants/${t.tenantId}`).set(P).send({ staffLoginLimit: 3 });
    expect([200, 204]).toContain(lowered.status);
    const seats = await req().get('/api/v1/tenant/staff-seats').set(H(t.admin.token));
    expect(seats.body).toMatchObject({ limit: 3, used: 3, free: 0 });
    const fourth = await req().post('/api/v1/tenant/users').set(H(t.admin.token)).send({ email: `fourth@${t.slug}.test`, fullName: 'Fourth', kind: 'STAFF', roles: [{ role: 'REPORT_VIEWER' }] });
    expect(fourth.status).toBe(409);
    expect(fourth.body.code).toBe('STAFF_LOGIN_LIMIT');
  });
});
