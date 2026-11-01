import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestContext, provisionTenant, createStaff, createApiKey, activationTokenFor, login, type TestContext, type ProvisionedTenant } from './helpers.js';
import { DEFAULT_PROHIBITED_APPS } from '../src/modules/seb/settings.js';

/**
 * Screen watch and the AI-tool signals, against the real database: the exam turns it on (consent and a new policy
 * version), the student's live attempt sends pictures from the admitted device only, proctors see them with the gaps
 * measured by the server's clock, and the new signal classes go to a person, never counted on their own.
 */
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]).toString('base64')}`;
const DEV_A = randomUUID();
const DEV_B = randomUUID();
const NOT_JPEG = `data:image/jpeg;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}`;

describe('screen watch and AI-tool signals', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;
  let examCell: Awaited<ReturnType<typeof createStaff>>;
  let proctor: Awaited<ReturnType<typeof createStaff>>;
  const PW = 'Student-Passw0rd!2026';
  const A = { email: '', id: '', token: '' };
  const B = { email: '', id: '', token: '' };
  let examId = '';
  let attemptA = '';
  const H = (token: string) => ({ Host: t.host, Authorization: `Bearer ${token}`, 'User-Agent': 'ExamOS-Test/1.0' });
  const req = () => ctx.request();
  const frame = (attemptId: string, token: string, device: string, body: Record<string, unknown> = {}) =>
    req().post(`/api/v1/student/attempts/${attemptId}/screen-frames`).set(H(token)).set('x-device-session', device).send({ image: JPEG, displaySurface: 'monitor', width: 1280, height: 720, ...body });

  async function exam(code: string) {
    const r = await req().post('/api/v1/exams').set(H(examCell.token)).send({ code, title: code, courseCode: 'CS200', examType: 'MID_1', securityProfile: 'BASIC_BROWSER', durationMinutes: 60, windowStartAt: new Date(Date.now() - 60_000).toISOString(), windowEndAt: new Date(Date.now() + 3600_000).toISOString() });
    return r.body.examId as string;
  }
  async function liveAttempt(examId: string, userId: string, device: string) {
    const id = randomUUID();
    await ctx.admin('exam_allocations').insert({ id: randomUUID(), tenant_id: t.tenantId, exam_id: examId, user_id: userId, status: 'ALLOCATED' });
    await ctx.admin('exam_attempts').insert({ id, tenant_id: t.tenantId, exam_id: examId, user_id: userId, status: 'ACTIVE', attempt_no: 1, device_session_id: device, deadline_at: new Date(Date.now() + 3600_000) });
    return id;
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    t = await provisionTenant(ctx, 'scr');
    [examCell, proctor] = await Promise.all([createStaff(ctx, t, ['EXAM_CELL_OPERATOR'], 'examcell'), createStaff(ctx, t, ['CHIEF_PROCTOR'], 'proctor')]);
    const key = await createApiKey(ctx, t, ['roster:write']);
    const K = (p: string) => req().put(`/api/v1/integration/v1/roster/${p}/batch`).set('Authorization', `Bearer ${key.apiKey}`).set('Idempotency-Key', randomUUID()).set('X-ExamOS-Provider', 'uos');
    await K('academic-units').send({ rows: [{ kind: 'DEPARTMENT', code: 'CSE', name: 'CSE' }] });
    await K('courses').send({ rows: [{ code: 'CS200', name: 'Systems', departmentCode: 'CSE' }] });
    A.email = `a@${t.slug}.test`;
    B.email = `b@${t.slug}.test`;
    await K('persons').send({ rows: [{ externalId: 'S-A', kind: 'STUDENT', fullName: 'Student A', email: A.email }, { externalId: 'S-B', kind: 'STUDENT', fullName: 'Student B', email: B.email }] });
    for (const s of [A, B]) {
      await req().post('/api/v1/auth/activate').set('Host', t.host).send({ token: await activationTokenFor(ctx, t.tenantId, s.email), password: PW });
      const l = await login(ctx, t.host, s.email, PW);
      s.token = l.accessToken;
      s.id = l.user.id;
    }
    examId = await exam('CS200-SW');
  });
  afterAll(async () => ctx.close());

  it('the exam turns screen watch on: screen consent, a new policy version, frozen once live', async () => {
    const pre = await liveAttempt(examId, B.id, randomUUID());
    await ctx.admin('exam_attempts').where({ id: pre }).update({ status: 'PRECHECK_AVAILABLE', device_session_id: null });
    await ctx.admin('exams').where({ id: examId }).update({ status: 'PRECHECK' });
    const policyOf = () => req().get(`/api/v1/student/attempts/${pre}/policy`).set(H(B.token));
    const before = await policyOf();
    expect(before.body).toMatchObject({ screenWatch: null, consentPurposes: [] });
    expect((await req().put(`/api/v1/exams/${examId}/client-policy`).set(H(examCell.token)).send({ screenWatch: { intervalSeconds: 5 } })).status).toBe(400);
    expect((await req().put(`/api/v1/exams/${examId}/client-policy`).set(H(B.token)).send({ screenWatch: { intervalSeconds: 30 } })).status).toBe(403);
    expect((await req().put(`/api/v1/exams/${examId}/client-policy`).set(H(examCell.token)).send({ screenWatch: { intervalSeconds: 30 } })).status).toBe(200);
    const after = await policyOf();
    expect(after.body.screenWatch).toEqual({ intervalSeconds: 30 });
    expect(after.body.consentPurposes).toEqual(['SCREEN']);
    expect(after.body.policyVersion).not.toBe(before.body.policyVersion);
    await req().put(`/api/v1/exams/${examId}/client-policy`).set(H(examCell.token)).send({ screenWatch: { intervalSeconds: 30 } });
    expect((await policyOf()).body.policyVersion).toBe(after.body.policyVersion);
    await ctx.admin('exams').where({ id: examId }).update({ status: 'LIVE' });
    const frozen = await req().put(`/api/v1/exams/${examId}/client-policy`).set(H(examCell.token)).send({ screenWatch: null });
    expect(frozen.body.code).toBe('POLICY_FROZEN');
    await ctx.admin('exam_attempts').where({ id: pre }).delete();
    await ctx.admin('exam_allocations').where({ exam_id: examId, user_id: B.id }).delete();
  });

  it('pictures come only from the student’s own live attempt, on the admitted device, as real JPEGs', async () => {
    attemptA = await liveAttempt(examId, A.id, DEV_A);
    const ok = await frame(attemptA, A.token, DEV_A);
    expect(ok.status).toBe(201);
    expect(ok.body.frameId).toBeTruthy();
    expect((await frame(attemptA, B.token, DEV_A)).status).toBe(404); // someone else's attempt
    expect((await frame(attemptA, A.token, 'another-device')).status).toBeGreaterThanOrEqual(400); // second device
    const fake = await frame(attemptA, A.token, DEV_A, { image: NOT_JPEG });
    expect(fake.status).toBe(400);
    expect(fake.body.code).toBe('INVALID_IMAGE');
    expect((await frame(attemptA, A.token, DEV_A, { image: 'data:image/png;base64,AAAA' })).status).toBe(400);
    expect((await frame(attemptA, A.token, DEV_A, { displaySurface: 'window' })).status).toBe(201);
    // an exam without screen watch takes no pictures
    const plain = await exam('CS200-PLAIN');
    await ctx.admin('exams').where({ id: plain }).update({ status: 'LIVE' });
    const plainAttempt = await liveAttempt(plain, B.id, DEV_B);
    expect((await frame(plainAttempt, B.token, DEV_B)).body.code).toBe('SCREEN_WATCH_OFF');
    // a submitted attempt takes no more pictures
    await ctx.admin('exam_attempts').where({ id: plainAttempt }).update({ status: 'SUBMITTED' });
    expect((await frame(plainAttempt, B.token, DEV_B)).status).toBe(409);
    expect(await ctx.admin('screen_frames').where({ attempt_id: attemptA })).toHaveLength(2);
  });

  it('proctors see the pictures, which ones were not the entire screen, and gaps measured by the server', async () => {
    // two older pictures 5 minutes apart: a gap longer than twice the 30-second interval
    const old = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    await ctx.admin('screen_frames').insert([
      { tenant_id: t.tenantId, attempt_id: attemptA, object_key: 'missing.jpg', sha256: 'x', byte_length: 1, width: 1, height: 1, display_surface: 'monitor', received_at: old(10) },
      { tenant_id: t.tenantId, attempt_id: attemptA, object_key: 'missing.jpg', sha256: 'x', byte_length: 1, width: 1, height: 1, display_surface: 'monitor', received_at: old(5) },
    ]);
    const list = await req().get(`/api/v1/proctor/attempts/${attemptA}/screen-frames`).set(H(proctor.token));
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ enabled: true, intervalSeconds: 30, overdue: false });
    expect(list.body.frames).toHaveLength(4);
    expect(list.body.frames[0].entireScreen).toBe(false); // the newest was a window
    expect(list.body.gaps.map((g: { seconds: number }) => Math.round(g.seconds / 60))).toEqual([5, 5]);
    const img = await req().get(`/api/v1/proctor/screen-frames/${list.body.frames[1].id}.jpg`).set(H(proctor.token)).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect((img.body as Buffer).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    // students never see the proctors' screens; the viewing itself is on record
    expect((await req().get(`/api/v1/proctor/attempts/${attemptA}/screen-frames`).set(H(A.token))).status).toBe(403);
    expect((await req().get(`/api/v1/proctor/screen-frames/${list.body.frames[1].id}.jpg`).set(H(A.token))).status).toBe(403);
    expect(await ctx.admin('audit_events').where({ tenant_id: t.tenantId, action: 'proctor.screen_frames_viewed' })).toHaveLength(1);
    // nothing for a while: the server says so
    await ctx.admin('screen_frames').where({ attempt_id: attemptA }).update({ received_at: old(3) });
    expect((await req().get(`/api/v1/proctor/attempts/${attemptA}/screen-frames`).set(H(proctor.token))).body.overdue).toBe(true);
  });

  it('a student cannot flood the server with pictures', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 13; i++) statuses.push((await frame(attemptA, A.token, DEV_A)).status);
    // 12 a minute per student, counting the uploads made above: the first ones pass, then 429
    const first = statuses.indexOf(429);
    expect(first).toBeGreaterThan(0);
    expect(statuses.slice(0, first).every((s) => s === 201)).toBe(true);
    expect(statuses.slice(first).every((s) => s === 429)).toBe(true);
  });

  it('the new AI-tool signals reach a proctor for review and are never counted on their own', async () => {
    const r = await req()
      .post('/api/v1/proctor/events')
      .set(H(A.token))
      .send({
        events: [
          { attemptId: attemptA, signalClass: 'PAGE_TAMPERED', sourceEventId: randomUUID(), metadata: { kind: 'frame', tag: 'iframe', origin: 'chrome-extension://abcdef' } },
          { attemptId: attemptA, signalClass: 'TEXT_NOT_TYPED', sourceEventId: randomUUID(), metadata: { reason: 'untrusted', chars: 412, field: 'Answer' } },
          { attemptId: attemptA, signalClass: 'SCREEN_SHARE_ENDED', sourceEventId: randomUUID(), metadata: { reason: 'stopped', afterSeconds: 300 } },
        ],
      });
    expect(r.status).toBe(202);
    const incidents = await ctx.admin('proctor_incidents').where({ attempt_id: attemptA }).whereIn('signal_class', ['PAGE_TAMPERED', 'TEXT_NOT_TYPED', 'SCREEN_SHARE_ENDED']);
    expect(incidents).toHaveLength(3);
    expect(incidents.every((i) => i.status === 'PROCTOR_REVIEW')).toBe(true);
    expect(await ctx.admin('proctor_warnings').where({ attempt_id: attemptA })).toHaveLength(0);
  });

  it('Safe Exam Browser closes desktop AI apps and AI overlays on Windows and macOS', () => {
    const names = DEFAULT_PROHIBITED_APPS.map((a) => `${a.os}:${a.executable}`);
    for (const n of ['1:ChatGPT.exe', '0:ChatGPT', '1:claude.exe', '0:Claude', '1:Copilot.exe', '1:Perplexity.exe', '0:Perplexity', '1:Cluely.exe', '1:Grammarly.Desktop.exe']) expect(names).toContain(n);
  });
});
