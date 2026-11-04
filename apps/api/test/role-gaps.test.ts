import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestContext, provisionTenant, createStaff, createApiKey, activationTokenFor, login, type TestContext, type ProvisionedTenant } from './helpers.js';
import { paperAccess } from '../src/modules/papers/service.js';
import { answerMatchesKey } from '../src/modules/evaluation/service.js';
import { departmentScopeOf } from '../src/middleware/auth.js';

/** Regressions from the role-by-role gap audit (docs/reviews/role-gap-audit.md). */
describe('role gap regressions', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;
  let proctor: Awaited<ReturnType<typeof createStaff>>;
  let setter: Awaited<ReturnType<typeof createStaff>>;
  let examiner: Awaited<ReturnType<typeof createStaff>>;
  const H = (token: string) => ({ Host: t.host, Authorization: `Bearer ${token}` });
  const req = () => ctx.request();
  const PW = 'Brand-New-Passw0rd!2026';

  async function createStudent(activate = true) {
    const email = `s-${randomUUID().slice(0, 6)}@${t.slug}.test`;
    const res = await req().post('/api/v1/tenant/users').set(H(t.admin.token)).send({ email, fullName: 'Student', kind: 'STUDENT', roles: [] });
    expect(res.status).toBe(201);
    let token = '';
    if (activate) {
      const act = await req().post('/api/v1/auth/activate').set('Host', t.host).send({ token: await activationTokenFor(ctx, t.tenantId, email), password: 'Student-Passw0rd!2026' });
      expect(act.status).toBe(200);
      token = act.body.accessToken;
    }
    return { userId: res.body.userId as string, email, token };
  }

  async function resetTokenFor(email: string) {
    const row = await ctx.admin('mail_dispatches').where({ tenant_id: t.tenantId, category: 'PASSWORD_RESET', to_address: email }).orderBy('created_at', 'desc').first('body_text');
    return decodeURIComponent(/token=([^\s]+)/.exec(row.body_text as string)![1]!);
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    t = await provisionTenant(ctx, 'gaps');
    [proctor, setter, examiner] = await Promise.all([createStaff(ctx, t, ['PROCTOR'], 'proctor'), createStaff(ctx, t, ['QUESTION_SETTER'], 'setter'), createStaff(ctx, t, ['EVALUATOR'], 'examiner')]);
  });
  afterAll(async () => ctx.close());

  it('refuses an access token in the URL; only the bearer header authenticates', async () => {
    const res = await req().get(`/api/v1/auth/me?token=${t.admin.token}`).set('Host', t.host);
    expect(res.status).toBe(401);
  });

  it('forgot-password answers the same for a stranger, and a reset works once, clears the lock and ends sessions', async () => {
    const s = await createStudent();
    const stranger = await req().post('/api/v1/auth/forgot-password').set('Host', t.host).send({ email: `nobody@${t.slug}.test` });
    const known = await req().post('/api/v1/auth/forgot-password').set('Host', t.host).send({ email: s.email });
    expect([stranger.status, known.status]).toEqual([202, 202]);
    expect(stranger.body).toEqual(known.body);

    for (let i = 0; i < 5; i++) await req().post('/api/v1/auth/login').set('Host', t.host).send({ email: s.email, password: 'wrong-password-here' });
    expect((await ctx.admin('users').where({ id: s.userId }).first('locked_until')).locked_until).not.toBeNull();

    const token = await resetTokenFor(s.email);
    const reset = await req().post('/api/v1/auth/reset-password').set('Host', t.host).send({ token, password: PW });
    expect(reset.status).toBe(204);
    const again = await req().post('/api/v1/auth/reset-password').set('Host', t.host).send({ token, password: PW });
    expect(again.status).toBe(401);
    expect(again.body.code).toBe('RESET_INVALID');
    await login(ctx, t.host, s.email, PW);
    expect((await req().get('/api/v1/auth/me').set(H(s.token))).status).toBe(401);
  });

  it('a newer reset link cancels the older one', async () => {
    const s = await createStudent();
    await req().post('/api/v1/auth/forgot-password').set('Host', t.host).send({ email: s.email });
    const first = await resetTokenFor(s.email);
    await new Promise((r) => setTimeout(r, 5));
    await req().post('/api/v1/auth/forgot-password').set('Host', t.host).send({ email: s.email });
    const res = await req().post('/api/v1/auth/reset-password').set('Host', t.host).send({ token: first, password: PW });
    expect(res.body.code).toBe('RESET_INVALID');
  });

  it('an admin can resend an activation link, and disabling kills unused links for good', async () => {
    const s = await createStudent(false);
    const old = await activationTokenFor(ctx, t.tenantId, s.email);
    const resend = await req().post(`/api/v1/tenant/users/${s.userId}/resend-activation`).set(H(t.admin.token));
    expect(resend.status).toBe(202);
    expect((await req().post('/api/v1/auth/activate').set('Host', t.host).send({ token: old, password: PW })).status).toBe(401);

    const fresh = await activationTokenFor(ctx, t.tenantId, s.email);
    const off = await req().patch(`/api/v1/tenant/users/${s.userId}/status`).set(H(t.admin.token)).send({ status: 'INACTIVE', reason: 'left the university' });
    expect(off.status).toBe(200);
    expect((await req().post('/api/v1/auth/activate').set('Host', t.host).send({ token: fresh, password: PW })).status).toBe(401);
    expect((await ctx.admin('users').where({ id: s.userId }).first('status')).status).toBe('INACTIVE');

    const active = await createStudent();
    const refused = await req().post(`/api/v1/tenant/users/${active.userId}/resend-activation`).set(H(t.admin.token));
    expect(refused.body.code).toBe('ALREADY_ACTIVATED');
  });

  it('staff without a user permission cannot open or change someone else\'s profile', async () => {
    const s = await createStudent();
    expect((await req().get(`/api/v1/student/profile?userId=${s.userId}`).set(H(proctor.token))).status).toBe(403);
    expect((await req().get(`/api/v1/student/profile/photo?userId=${s.userId}`).set(H(proctor.token))).status).toBe(403);
    expect((await req().get(`/api/v1/student/profile?userId=${s.userId}`).set(H(t.admin.token))).status).toBe(200);
    expect((await req().get('/api/v1/student/profile?userId=not-a-uuid').set(H(t.admin.token))).status).toBe(400);
  });

  it('every append-only evidence table carries the mutation trigger', async () => {
    const rows = await ctx.admin('pg_trigger').whereIn('tgname', ['submission_manifests_append_only', 'resume_grants_append_only', 'controller_publication_grants_append_only']).select('tgname');
    expect(rows).toHaveLength(3);
  });

  it('keeps a paper from everyone but its authors before the exam, and refuses an MCQ without options for review', async () => {
    const key = await createApiKey(ctx, t, ['roster:write']);
    const K = (p: string) => req().put(`/api/v1/integration/v1/roster/${p}/batch`).set('Authorization', `Bearer ${key.apiKey}`).set('Idempotency-Key', randomUUID()).set('X-ExamOS-Provider', 'uos');
    await K('academic-units').send({ rows: [{ kind: 'DEPARTMENT', code: 'CSE', name: 'CSE' }] });
    await K('courses').send({ rows: [{ code: 'CS101', name: 'Intro', departmentCode: 'CSE' }] });
    const start = new Date(Date.now() + 3600_000).toISOString();
    const end = new Date(Date.now() + 3 * 3600_000).toISOString();
    const create = await req().post('/api/v1/exams').set(H(t.admin.token)).send({ code: `CS101-${randomUUID().slice(0, 4)}`, title: 'Intro', courseCode: 'CS101', examType: 'MID_1', securityProfile: 'BASIC_BROWSER', durationMinutes: 60, windowStartAt: start, windowEndAt: end, maxMarks: 10 });
    expect(create.status).toBe(201);
    const examId = create.body.examId;
    const put = await req().put(`/api/v1/exams/${examId}/paper`).set(H(setter.token)).send({
      title: 'Paper',
      sections: [{ code: 'A', title: 'A' }],
      questions: [{ questionId: 'Q1', sectionCode: 'A', number: 1, kind: 'MCQ', prompt: { blocks: [{ id: 'p', kind: 'paragraph', content: 'Pick' }] }, maxMarks: 10, expectedAnswer: 'B', attachments: [] }],
    });
    expect(put.status).toBeLessThan(300);
    const noOptions = await req().post(`/api/v1/exams/${examId}/paper/submit-for-review`).set(H(setter.token));
    expect(noOptions.body.code).toBe('MCQ_OPTIONS_REQUIRED');

    const asExaminer = await req().get(`/api/v1/exams/${examId}/paper`).set(H(examiner.token));
    expect(asExaminer.status).toBe(403);
    expect(asExaminer.body.code).toBe('PAPER_RESTRICTED');
    const asProctor = await req().get(`/api/v1/exams/${examId}/paper`).set(H(proctor.token));
    expect(asProctor.status).toBe(403);
    const asSetter = await req().get(`/api/v1/exams/${examId}/paper`).set(H(setter.token));
    expect(asSetter.body.paper.questions[0].expectedAnswer).toBe('B');
  });

  it('decides paper access by role and exam stage', () => {
    const none = { canAuthor: false, canMark: false };
    const marker = { canAuthor: false, canMark: true };
    expect(paperAccess({ canAuthor: true, canMark: false }, 'DRAFT')).toBe('KEYS');
    expect(paperAccess(marker, 'PRECHECK')).toBe('NONE');
    expect(paperAccess(marker, 'LIVE')).toBe('PROMPTS');
    expect(paperAccess(marker, 'CLOSED')).toBe('KEYS');
    expect(paperAccess(none, 'CLOSED')).toBe('PROMPTS');
  });

  it('scores against the key exactly, never by substring', () => {
    expect(answerMatchesKey('MCQ', [{ kind: 'choice', content: { selected: 'B' } }], 'B')).toBe(true);
    expect(answerMatchesKey('MCQ', [{ kind: 'choice', content: { selected: 'A' } }], 'B')).toBe(false);
    expect(answerMatchesKey('MCQ', [{ kind: 'paragraph', content: 'A long essay about a topic' }], 'A')).toBe(false);
    expect(answerMatchesKey('NUMERIC', [{ kind: 'paragraph', content: '15' }], '5')).toBe(false);
    expect(answerMatchesKey('NUMERIC', [{ kind: 'paragraph', content: '5.0' }], 5)).toBe(true);
    expect(answerMatchesKey('MCQ', [{ kind: 'choice', content: { selected: 'A' } }], null)).toBe(false);
    expect(answerMatchesKey('MCQ', [{ kind: 'choice', content: { selected: 'C' } }], { key: 'C' })).toBe(true);
  });

  it('scopes the analytics overview to a reader\'s departments', async () => {
    const d = '11111111-1111-4111-8111-111111111111';
    expect(departmentScopeOf([{ role: 'HOD', scopeType: 'DEPARTMENT', scopeId: d }], 'analytics:read')).toEqual([d]);
    expect(departmentScopeOf([{ role: 'REPORT_VIEWER', scopeType: 'TENANT', scopeId: null }], 'analytics:read')).toBe('ALL');
    expect(departmentScopeOf([{ role: 'PROCTOR', scopeType: 'TENANT', scopeId: null }], 'analytics:read')).toBe('NONE');
    const res = await req().get('/api/v1/analytics/overview').set(H(t.admin.token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.overview.departments)).toBe(true);
    expect((await req().get('/api/v1/analytics/overview').set(H(proctor.token))).status).toBe(403);
  });
});
