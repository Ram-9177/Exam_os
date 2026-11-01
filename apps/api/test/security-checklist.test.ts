import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestContext, provisionTenant, createStaff, createApiKey, activationTokenFor, login, type TestContext, type ProvisionedTenant } from './helpers.js';
import { imageBytesMatch } from '../src/modules/profile/service.js';

/**
 * The security checklist, as tests: sign-out really signs out, an administrator's password reset signs the account
 * out everywhere and only the newest link works, one student cannot touch another student's attempt, uploads are
 * checked by their bytes, and costly work is capped per caller.
 */
describe('security checklist', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;
  let other: ProvisionedTenant;
  let examCell: Awaited<ReturnType<typeof createStaff>>;
  let examId = '';
  const PW = 'Student-Passw0rd!2026';
  const A = { email: '', id: '', token: '', refresh: '', attemptId: '' };
  const B = { email: '', token: '', attemptId: '' };
  const H = (token: string, host = t.host) => ({ Host: host, Authorization: `Bearer ${token}`, 'User-Agent': 'ExamOS-Test/1.0' });
  const req = () => ctx.request();

  beforeAll(async () => {
    ctx = await createTestContext();
    [t, other] = await Promise.all([provisionTenant(ctx, 'sec'), provisionTenant(ctx, 'sec2')]);
    examCell = await createStaff(ctx, t, ['EXAM_CELL_OPERATOR'], 'examcell');
    const key = await createApiKey(ctx, t, ['roster:write']);
    const K = (p: string) => req().put(`/api/v1/integration/v1/roster/${p}/batch`).set('Authorization', `Bearer ${key.apiKey}`).set('Idempotency-Key', randomUUID()).set('X-ExamOS-Provider', 'uos');
    await K('academic-units').send({ rows: [{ kind: 'DEPARTMENT', code: 'CSE', name: 'CSE' }] });
    await K('courses').send({ rows: [{ code: 'CS100', name: 'Intro', departmentCode: 'CSE' }] });
    A.email = `a@${t.slug}.test`;
    B.email = `b@${t.slug}.test`;
    await K('persons').send({ rows: [{ externalId: 'S-A', kind: 'STUDENT', fullName: 'Student A', email: A.email }, { externalId: 'S-B', kind: 'STUDENT', fullName: 'Student B', email: B.email }] });
    await K('enrollments').send({ rows: ['S-A', 'S-B'].map((s) => ({ studentExternalId: s, courseCode: 'CS100', academicYear: '2026-27', term: 'ODD' })) });
    for (const s of [A, B]) {
      await req().post('/api/v1/auth/activate').set('Host', t.host).send({ token: await activationTokenFor(ctx, t.tenantId, s.email), password: PW });
      s.token = (await login(ctx, t.host, s.email, PW)).accessToken;
    }
    const a = await login(ctx, t.host, A.email, PW);
    Object.assign(A, { token: a.accessToken, refresh: a.refreshToken, id: a.user.id });

    const create = await req().post('/api/v1/exams').set(H(examCell.token)).send({ code: 'CS100-T1', title: 'Intro test', courseCode: 'CS100', examType: 'MID_1', academicYear: '2026-27', semester: 1, securityProfile: 'BASIC_BROWSER', durationMinutes: 30, windowStartAt: new Date(Date.now() - 60_000).toISOString(), windowEndAt: new Date(Date.now() + 3600_000).toISOString() });
    examId = create.body.examId;
    await req().put(`/api/v1/exams/${examId}/paper`).set(H(examCell.token)).send({ title: 'P', sections: [{ code: 'A', title: 'A' }], questions: [{ questionId: 'Q1', sectionCode: 'A', number: 1, kind: 'DESCRIPTIVE', maxMarks: 5, attachments: [], prompt: { blocks: [{ id: 'p', kind: 'paragraph', content: 'Explain.' }] } }] });
    for (const step of ['paper/submit-for-review', 'paper/approve']) await req().post(`/api/v1/exams/${examId}/${step}`).set(H(examCell.token));
    await req().post(`/api/v1/exams/${examId}/allocations`).set(H(examCell.token)).send({ studentExternalIds: ['S-A', 'S-B'], provider: 'uos' });
    for (const step of ['submit-for-review', 'approve', 'schedule', 'open-precheck']) await req().post(`/api/v1/exams/${examId}/${step}`).set(H(examCell.token));
    A.attemptId = (await req().get('/api/v1/student/me/exams').set(H(A.token))).body.exams[0].attemptId;
    B.attemptId = (await req().get('/api/v1/student/me/exams').set(H(B.token))).body.exams[0].attemptId;
  });
  afterAll(async () => ctx.close());

  it('two accounts: student B cannot read or change anything of student A’s attempt', async () => {
    expect(A.attemptId).toBeTruthy();
    expect(A.attemptId).not.toBe(B.attemptId);
    const id = A.attemptId;
    const calls: Array<[string, string, unknown?]> = [
      ['GET', `/api/v1/student/attempts/${id}/policy`],
      ['GET', `/api/v1/student/attempts/${id}/paper`],
      ['POST', `/api/v1/student/attempts/${id}/prechecks`, { clientBuild: 'chrome-130' }],
      ['POST', `/api/v1/student/attempts/${id}/entry-grants`, {}],
      ['GET', `/api/v1/student/attempts/${id}/answers/Q1`],
      ['PUT', `/api/v1/student/attempts/${id}/answers/Q1`, { clientOperationId: randomUUID(), baseRevision: 0, answerFormat: 'hybrid-v1', ops: [], contentSha256: 'a'.repeat(64) }],
      ['POST', `/api/v1/student/attempts/${id}/heartbeat`, {}],
      ['POST', `/api/v1/student/attempts/${id}/submit`, { idempotencyKey: randomUUID() }],
      ['POST', `/api/v1/student/attempts/${id}/code-runs`, { questionId: 'Q1', language: 'python', source: 'print(1)' }],
      ['GET', `/api/v1/student/attempts/${id}/booklet`],
      ['GET', `/api/v1/student/attempts/${id}/booklet.pdf`],
      ['GET', `/api/v1/student/attempts/${id}/revaluation`],
      ['POST', `/api/v1/student/attempts/${id}/revaluation`, { reason: 'Please recheck question one, I think it was missed.' }],
      // staff screens are not reachable with a student token either
      ['GET', `/api/v1/candidates/${id}/rubric-proposals`],
      ['GET', `/api/v1/exams/${examId}/candidates`],
    ];
    for (const [method, path, payload] of calls) {
      const r = await req()[method.toLowerCase() as 'get'](path).set(H(B.token)).set('x-device-session', 'x').send(payload as object);
      expect([path, r.status >= 400 && r.status < 500]).toEqual([path, true]);
      expect(JSON.stringify(r.body)).not.toContain('Student A');
    }
    // and the attempt is untouched: still A's, no prechecks started, no answers
    expect(await ctx.admin('precheck_runs').where({ attempt_id: id })).toHaveLength(0);
    expect(await ctx.admin('answer_documents').where({ attempt_id: id })).toHaveLength(0);
    // without signing in, nothing at all
    for (const [method, path] of calls) expect((await req()[method.toLowerCase() as 'get'](path).set('Host', t.host)).status).toBe(401);
  });

  it('sign-out ends the session at once: the access token and the refresh token stop working', async () => {
    const s = await login(ctx, t.host, B.email, PW);
    expect((await req().get('/api/v1/auth/me').set(H(s.accessToken))).status).toBe(200);
    expect((await req().post('/api/v1/auth/logout').set(H(s.accessToken))).status).toBeLessThan(300);
    const me = await req().get('/api/v1/auth/me').set(H(s.accessToken));
    expect(me.status).toBe(401);
    expect((await req().post('/api/v1/auth/refresh').set('Host', t.host).send({ refreshToken: s.refreshToken })).status).toBe(401);
  });

  it('password reset by an administrator: signed out everywhere, only the newest link works, the new password replaces the old', async () => {
    // only someone with users:write, only for a user of this tenant
    expect((await req().post(`/api/v1/tenant/users/${A.id}/password-reset`).set(H(B.token))).status).toBe(403);
    expect((await req().post(`/api/v1/tenant/users/${A.id}/password-reset`).set(H(examCell.token))).status).toBe(403);
    expect((await req().post(`/api/v1/tenant/users/${A.id}/password-reset`).set(H(other.admin.token, other.host))).status).toBe(404);

    const first = await req().post(`/api/v1/tenant/users/${A.id}/password-reset`).set(H(t.admin.token));
    expect(first.status).toBe(202);
    expect(first.body.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect((await req().get('/api/v1/auth/me').set(H(A.token))).status).toBe(401);
    expect((await req().post('/api/v1/auth/refresh').set('Host', t.host).send({ refreshToken: A.refresh })).status).toBe(401);
    const firstLink = await activationTokenFor(ctx, t.tenantId, A.email);

    // a second reset: the first link stops working
    expect((await req().post(`/api/v1/tenant/users/${A.id}/password-reset`).set(H(t.admin.token))).status).toBe(202);
    const secondLink = await activationTokenFor(ctx, t.tenantId, A.email);
    expect(secondLink).not.toBe(firstLink);
    expect((await req().post('/api/v1/auth/activate').set('Host', t.host).send({ token: firstLink, password: 'Another-Passw0rd!2026' })).status).toBe(401);

    // someone still holding the old password signs in before the link is used: setting the new password ends that session too
    const stale = await login(ctx, t.host, A.email, PW);
    const NEW = 'Fresh-Passw0rd!2026';
    expect((await req().post('/api/v1/auth/activate').set('Host', t.host).send({ token: secondLink, password: NEW })).status).toBe(200);
    expect((await req().get('/api/v1/auth/me').set(H(stale.accessToken))).status).toBe(401);
    expect((await req().post('/api/v1/auth/login').set('Host', t.host).send({ email: A.email, password: PW })).status).toBe(401);
    expect((await req().post('/api/v1/auth/login').set('Host', t.host).send({ email: A.email, password: NEW })).status).toBe(200);
    // the link is single-use
    expect((await req().post('/api/v1/auth/activate').set('Host', t.host).send({ token: secondLink, password: 'Third-Passw0rd!2026' })).status).toBe(401);
    expect(await ctx.admin('audit_events').where({ tenant_id: t.tenantId, action: 'user.password_reset_sent' })).toHaveLength(2);
  });

  it('uploads: the bytes must really be the image type claimed (an HTML file called .png is refused)', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    expect(imageBytesMatch(png, 'image/png')).toBe(true);
    expect(imageBytesMatch(png, 'image/jpeg')).toBe(false);
    expect(imageBytesMatch(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'image/jpeg')).toBe(true);
    expect(imageBytesMatch(Buffer.from('RIFF\0\0\0\0WEBPVP8 '), 'image/webp')).toBe(true);
    expect(imageBytesMatch(Buffer.from('<html><script>alert(1)</script></html>'), 'image/png')).toBe(false);
    const s = await login(ctx, t.host, B.email, PW);
    const fake = await req()
      .post('/api/v1/student/profile/photo')
      .set(H(s.accessToken))
      .send({ dataUrl: `data:image/png;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}`, consentGiven: true });
    expect(fake.status).toBe(400);
    expect(fake.body.code).toBe('INVALID_IMAGE');
  });

  it('costly work is capped per caller: exam-wide analysis answers 429 after its limit', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await req().post(`/api/v1/exams/${examId}/similarity-analysis`).set(H(examCell.token)).send({})).status);
    expect(statuses.slice(0, 10).every((s) => s < 429)).toBe(true);
    expect(statuses[10]).toBe(429);
    // another caller has their own allowance
    expect((await req().post(`/api/v1/exams/${examId}/similarity-analysis`).set(H(t.admin.token)).send({})).status).not.toBe(429);
  });
});
