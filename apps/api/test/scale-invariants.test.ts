import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@examos/db';
import { createTestContext, provisionTenant, createStaff, createApiKey, activationTokenFor, answerHash, cleanScan, type TestContext, type ProvisionedTenant } from './helpers.js';
import { sweepStaleHeartbeats } from '../src/modules/attempts/service.js';
import { sealClosedExamAttempts, sweepClosedExams } from '../src/modules/exams/service.js';
import { sha256Hex } from '../src/lib/crypto.js';

/**
 * Invariants that only break with 2,000 students at once: hash chains that
 * fork under concurrent appends, incidents duplicated by parallel signals, a
 * heartbeat sweep that bounces everyone after a Redis restart, a close that
 * seals every attempt inside one transaction, and a refresh rotation that logs
 * a student out because one response was lost.
 */
describe('exam-day invariants under concurrency', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;
  let examCell: Awaited<ReturnType<typeof createStaff>>;
  let examId = '';
  const PASSWORD = 'Student-Passw0rd!2026';
  const ADMITTED_IP = '10.20.0.1';
  const questionIds = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'];
  interface Student { externalId: string; email: string; token: string; attemptId: string; device: string }
  const students: Student[] = [];
  const H = (token: string, ip = ADMITTED_IP) => ({ Host: t.host, Authorization: `Bearer ${token}`, 'X-Forwarded-For': ip, 'User-Agent': 'ExamOS-Test/1.0' });
  const req = () => ctx.request();
  const saveBody = (text: string, baseRevision = 0) => ({ clientOperationId: randomUUID(), baseRevision, answerFormat: 'hybrid-v1', ops: [{ op: 'upsert-block', blockId: 'b1', kind: 'paragraph', content: text }], contentSha256: answerHash([{ id: 'b1', kind: 'paragraph', content: text }]) });
  const attemptStatus = async (attemptId: string) => (await ctx.admin('exam_attempts').where('id', attemptId).first('status')).status as string;
  const hbKey = (attemptId: string) => `attempt:heartbeat:${attemptId}`;
  let roster: Array<{ externalId: string; email: string; token: string }> = [];

  async function createExam(code: string): Promise<string> {
    const create = await req().post('/api/v1/exams').set(H(examCell.token)).send({ code, title: `Scale ${code}`, courseCode: 'SC101', examType: 'MID_1', academicYear: '2026-27', semester: 1, securityProfile: 'BASIC_BROWSER', durationMinutes: 120, windowStartAt: new Date(Date.now() - 60_000).toISOString(), windowEndAt: new Date(Date.now() + 4 * 3600_000).toISOString(), policy: { ipPolicy: 'REVIEW' } });
    expect(create.status).toBe(201);
    const id = create.body.examId as string;
    await req().put(`/api/v1/exams/${id}/paper`).set(H(examCell.token)).send({ title: 'Paper', sections: [{ code: 'A', title: 'Main' }], questions: questionIds.map((q, i) => ({ questionId: q, sectionCode: 'A', number: i + 1, kind: 'DESCRIPTIVE', prompt: { blocks: [{ id: `p${i}`, kind: 'paragraph', content: `Q${i + 1}` }] }, maxMarks: 10, attachments: [] })) });
    await req().post(`/api/v1/exams/${id}/paper/submit-for-review`).set(H(examCell.token));
    await req().post(`/api/v1/exams/${id}/paper/approve`).set(H(examCell.token));
    return id;
  }
  async function openAndAdmit(id: string, who: typeof roster): Promise<Student[]> {
    await req().post(`/api/v1/exams/${id}/allocations`).set(H(examCell.token)).send({ studentExternalIds: who.map((s) => s.externalId), provider: 'uos' });
    for (const step of ['submit-for-review', 'approve', 'schedule', 'open-precheck']) await req().post(`/api/v1/exams/${id}/${step}`).set(H(examCell.token));
    const out: Student[] = [];
    for (const s of who) {
      const mine = await req().get('/api/v1/student/me/exams').set(H(s.token));
      const attemptId = (mine.body.exams as Array<{ examId: string; attemptId: string }>).find((e) => e.examId === id)!.attemptId;
      const start = await req().post(`/api/v1/student/attempts/${attemptId}/prechecks`).set(H(s.token)).send({ clientBuild: 'chrome-130' });
      const runId = start.body.runId as string;
      const v = (body: Record<string, unknown>) => req().post(`/api/v1/student/prechecks/${runId}/items/verify`).set(H(s.token)).send(body);
      await v({ code: 'CLOCK_SYNC', clientClockMs: Date.now() });
      await v({ code: 'KEYBOARD_INPUT', keyboardSample: 'Congestion windows grow: 1, 2, 4, 8 (then linear)!' });
      await v({ code: 'SYSTEM_SCAN', scan: cleanScan() });
      await req().post(`/api/v1/student/prechecks/${runId}/practice-saves`).set(H(s.token)).send({ contentDigest: 'a'.repeat(64) });
      await v({ code: 'NETWORK_SAVE_ROUNDTRIP' });
      const fin = await req().post(`/api/v1/student/prechecks/${runId}/finalize`).set(H(s.token));
      expect(fin.body.status).toBe('READY');
      out.push({ ...s, attemptId, device: '' });
    }
    await req().post(`/api/v1/exams/${id}/start`).set(H(examCell.token));
    for (const s of out) {
      const g = await req().post(`/api/v1/student/attempts/${s.attemptId}/entry-grants`).set(H(s.token));
      const a = await req().post(`/api/v1/student/attempts/${s.attemptId}/admit`).set(H(s.token)).send({ grantToken: g.body.grantToken });
      expect(a.status).toBe(200);
      s.device = a.body.deviceSessionId;
    }
    return out;
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    t = await provisionTenant(ctx, 'scale');
    examCell = await createStaff(ctx, t, ['EXAM_CELL_OPERATOR', 'CHIEF_PROCTOR'], 'examcell');
    const key = await createApiKey(ctx, t, ['roster:write']);
    const K = (p: string) => req().put(`/api/v1/integration/v1/roster/${p}/batch`).set('Authorization', `Bearer ${key.apiKey}`).set('Idempotency-Key', randomUUID()).set('X-ExamOS-Provider', 'uos');
    await K('academic-units').send({ rows: [{ kind: 'DEPARTMENT', code: 'SCD', name: 'Scale' }] });
    await K('courses').send({ rows: [{ code: 'SC101', name: 'Scale 101', departmentCode: 'SCD' }] });
    const people = Array.from({ length: 15 }, (_, i) => ({ externalId: `UOS-9${String(i).padStart(3, '0')}`, kind: 'STUDENT' as const, fullName: `Scale ${i}`, email: `s${i}@${t.slug}.test` }));
    await K('persons').send({ rows: people });
    await K('enrollments').send({ rows: people.map((p) => ({ studentExternalId: p.externalId, courseCode: 'SC101', academicYear: '2026-27', term: 'ODD' })) });
    roster = [];
    for (const [i, p] of people.entries()) {
      const token = await activationTokenFor(ctx, t.tenantId, p.email);
      const act = await req().post('/api/v1/auth/activate').set('Host', t.host).set('X-Forwarded-For', `10.21.0.${i + 1}`).send({ token, password: PASSWORD });
      expect(act.status).toBe(200);
      roster.push({ externalId: p.externalId, email: p.email, token: act.body.accessToken });
    }
    examId = await createExam('SC101-A');
    students.push(...(await openAndAdmit(examId, roster.slice(0, 12))));
  }, 120_000);
  afterAll(async () => ctx.close());

  it('a burst of heartbeats, scans and saves for one attempt never forks its timeline chain nor duplicates an incident', async () => {
    const s = students[0]!;
    const ips = ['10.22.0.1', '10.22.0.2', '10.22.0.3'];
    const dual = () => cleanScan({ screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelRatio: 1, isExtended: true, displayCount: 2 } });
    const results = await Promise.all([
      ...Array.from({ length: 9 }, (_, i) => req().post(`/api/v1/student/attempts/${s.attemptId}/heartbeat`).set(H(s.token, ips[i % 3]!)).set('x-device-session', s.device)),
      ...Array.from({ length: 6 }, () => req().post(`/api/v1/student/attempts/${s.attemptId}/device-scans`).set(H(s.token)).send({ scan: dual() })),
      ...questionIds.map((q, i) => req().put(`/api/v1/student/attempts/${s.attemptId}/answers/${q}`).set(H(s.token)).set('x-device-session', s.device).send(saveBody(`answer ${i}`))),
    ]);
    if (results.some((r) => r.status >= 300)) console.log('BURST CODES', results.map((r) => `${r.status}:${r.body?.code ?? ''}:${String(r.body?.title ?? '').slice(0, 60)}`));
    expect(results.map((r) => r.status)).toEqual([...Array(9).fill(200), ...Array(6).fill(202), ...Array(5).fill(200)]);

    const events = await ctx.admin('attempt_event_log').where({ attempt_id: s.attemptId }).orderBy('seq');
    expect(events.length).toBeGreaterThanOrEqual(15);
    let prev: string | null = null;
    for (const e of events) {
      expect(e.prev_hash).toBe(prev);
      prev = e.hash;
    }
    const dualIncidents = await ctx.admin('proctor_incidents').where({ attempt_id: s.attemptId, signal_class: 'DUAL_SCREEN_DETECTED' });
    expect(dualIncidents).toHaveLength(1);
    expect(dualIncidents[0].event_count).toBe(6);
    const netIncidents = await ctx.admin('proctor_incidents').where({ attempt_id: s.attemptId, signal_class: 'NETWORK_ADDRESS_CHANGED' });
    expect(netIncidents).toHaveLength(1);
    expect(netIncidents[0].event_count).toBe(3);
    expect(await ctx.admin('proctor_warnings').where({ attempt_id: s.attemptId })).toHaveLength(0);
  });

  it('twenty concurrent logins keep the tenant audit chain unforked and walkable', async () => {
    const logins = await Promise.all(roster.slice(0, 10).flatMap((s, i) => [0, 1].map((k) => req().post('/api/v1/auth/login').set('Host', t.host).set('X-Forwarded-For', `10.23.${k}.${i + 1}`).send({ email: s.email, password: PASSWORD }))));
    expect(logins.every((r) => r.status === 200)).toBe(true);
    const forks = await ctx.admin.raw(`select count(*)::int as n from (select prev_hash from audit_events where tenant_id = ? and prev_hash is not null group by 1 having count(*) > 1) f`, [t.tenantId]);
    expect(forks.rows[0].n).toBe(0);
    const chain = await ctx.admin('audit_events').where({ tenant_id: t.tenantId }).orderBy('seq').select('prev_hash', 'hash');
    let prev: string | null = null;
    for (const e of chain) {
      expect(e.prev_hash).toBe(prev);
      prev = e.hash;
    }
  });

  it('the heartbeat sweep opens a fresh grace window when Redis forgot an attempt instead of bouncing a writing student', async () => {
    const s = students[1]!;
    await ctx.deps.redis.del(hbKey(s.attemptId));
    const sweep = () => withTenantTx(ctx.deps.db, t.tenantId, (trx) => sweepStaleHeartbeats(ctx.deps, trx, t.tenantId));
    expect(await sweep()).toBe(0);
    expect(await attemptStatus(s.attemptId)).toBe('ACTIVE');
    expect(await ctx.deps.redis.get(hbKey(s.attemptId))).toBeTruthy();
    // a genuinely silent client still moves to recovery (technical, no penalty)
    await ctx.deps.redis.set(hbKey(s.attemptId), String(Date.now() - 200_000));
    expect(await sweep()).toBe(1);
    expect(await attemptStatus(s.attemptId)).toBe('RECOVERY_PENDING');
    const back = await req().post(`/api/v1/student/attempts/${s.attemptId}/reconnect`).set(H(s.token)).set('x-device-session', s.device);
    expect(back.status).toBe(200);
    expect(Number(await ctx.deps.redis.get(hbKey(s.attemptId)))).toBeGreaterThan(Date.now() - 10_000);
    expect(await ctx.admin('proctor_incidents').where({ attempt_id: s.attemptId })).toHaveLength(0);
  });

  it('a refresh retried with the just-rotated token (lost response) is honoured once; reuse after that revokes the family', async () => {
    const s = roster[13]!;
    const login = async () => (await req().post('/api/v1/auth/login').set('Host', t.host).send({ email: s.email, password: PASSWORD })).body as { accessToken: string; refreshToken: string };
    const refresh = (token: string) => req().post('/api/v1/auth/refresh').set('Host', t.host).send({ refreshToken: token });
    const first = await login();
    const r1 = await refresh(first.refreshToken);
    expect(r1.status).toBe(200);
    const retry = await refresh(first.refreshToken);
    expect(retry.status).toBe(200);
    expect(retry.body.refreshToken).not.toBe(r1.body.refreshToken);
    // the pair from the first rotation is withdrawn: whoever holds it (nobody, or a thief) is out
    const dead = await refresh(r1.body.refreshToken);
    expect(dead.status).toBe(401);
    expect(dead.body.code).toBe('SESSION_REVOKED');
    // a second retry with the original token is reuse: the whole family goes, including the retried pair
    const again = await refresh(first.refreshToken);
    expect(again.status).toBe(401);
    expect(again.body.code).toBe('SESSION_REVOKED');
    expect((await refresh(retry.body.refreshToken)).status).toBe(401);
    expect((await req().get('/api/v1/auth/me').set('Host', t.host).set('Authorization', `Bearer ${retry.body.accessToken}`)).status).toBe(401);
    // outside the window there is no grace at all
    const second = await login();
    const r2 = await refresh(second.refreshToken);
    expect(r2.status).toBe(200);
    await ctx.admin('auth_sessions').where({ refresh_token_hash: sha256Hex(second.refreshToken) }).update({ rotated_at: new Date(Date.now() - 31_000) });
    const late = await refresh(second.refreshToken);
    expect(late.status).toBe(401);
    expect(late.body.code).toBe('SESSION_REVOKED');
    expect((await refresh(r2.body.refreshToken)).status).toBe(401);
    const audits = await ctx.admin('audit_events').where({ tenant_id: t.tenantId, action: 'auth.refresh_retried' });
    expect(audits).toHaveLength(1);
  });

  it('closing sets every open deadline in one statement and seals one attempt per transaction, inline and then by the worker', async () => {
    // exam A: 12 admitted students (one in RECOVERY_PENDING) close through the route
    const s0 = students[2]!;
    expect((await req().put(`/api/v1/student/attempts/${s0.attemptId}/answers/Q1`).set(H(s0.token)).set('x-device-session', s0.device).send(saveBody('before close'))).status).toBe(200);
    const close = await req().post(`/api/v1/exams/${examId}/close`).set(H(examCell.token));
    expect(close.status).toBe(200);
    expect(close.body).toMatchObject({ to: 'CLOSED', sealing: { sealed: 12, pending: 0 } });
    const rows = await ctx.admin('exam_attempts').where({ exam_id: examId }).select('status', 'deadline_at');
    expect(rows.every((r) => r.status === 'EXPIRED' && new Date(r.deadline_at).getTime() <= Date.now())).toBe(true);
    expect(await ctx.admin('submission_manifests').whereIn('attempt_id', students.map((s) => s.attemptId))).toHaveLength(12);
    const late = await req().put(`/api/v1/student/attempts/${s0.attemptId}/answers/Q1`).set(H(s0.token)).set('x-device-session', s0.device).send(saveBody('after close', 1));
    expect(late.status).toBe(409);
    expect(await sealClosedExamAttempts(ctx.deps, t.tenantId, examId)).toEqual({ sealed: 0, pending: 0 });

    // exam B: closed by the Examination Section while the worker finishes the sealing in batches
    const examB = await createExam('SC101-B');
    const trio = await openAndAdmit(examB, roster.slice(12, 15));
    const now = new Date();
    await ctx.admin('exams').where('id', examB).update({ status: 'CLOSED', closed_at: now });
    await ctx.admin('exam_attempts').where({ exam_id: examB }).update({ deadline_at: now });
    const refused = await req().put(`/api/v1/student/attempts/${trio[0]!.attemptId}/answers/Q1`).set(H(trio[0]!.token)).set('x-device-session', trio[0]!.device).send(saveBody('too late'));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('DEADLINE_PASSED');
    expect(await sealClosedExamAttempts(ctx.deps, t.tenantId, examB, { limit: 1 })).toEqual({ sealed: 1, pending: 2 });
    expect(await sweepClosedExams(ctx.deps)).toEqual({ sealed: 2, pending: 0 });
    expect(await sweepClosedExams(ctx.deps)).toEqual({ sealed: 0, pending: 0 });
    const b = await ctx.admin('exam_attempts').where({ exam_id: examB }).select('status');
    expect(b.map((r) => r.status)).toEqual(['EXPIRED', 'EXPIRED', 'EXPIRED']);
    expect(await ctx.admin('submission_manifests').whereIn('attempt_id', trio.map((s) => s.attemptId))).toHaveLength(3);
  }, 60_000);
});
