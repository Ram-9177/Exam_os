import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@examos/db';
import { createTestContext, provisionTenant, createStaff, createApiKey, activationTokenFor, answerHash, type TestContext, type ProvisionedTenant } from './helpers.js';
import { sweepStaleHeartbeats } from '../src/modules/attempts/service.js';
import { sha256Hex } from '../src/lib/crypto.js';

/**
 * "We cannot predict the student" (third brief): technical interruptions are
 * never penalised and deliberate second-device use is evidence for a human,
 * not an automatic sanction. Also covers the Safe Exam Browser Config Key
 * verification path for SECURE_BYOD exams.
 */
describe('interruptions, recovery and the secure client', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;
  let examCell: Awaited<ReturnType<typeof createStaff>>;
  let chief: Awaited<ReturnType<typeof createStaff>>;
  let examId = '';
  const student = { email: '', token: '', attemptId: '', device: '' };
  const SEB_CONFIG_KEY = 'd41d8cd98f00b204e9800998ecf8427e00000000000000000000000000000000';
  const H = (token: string) => ({ Host: t.host, Authorization: `Bearer ${token}` });
  const req = () => ctx.request();

  beforeAll(async () => {
    ctx = await createTestContext();
    t = await provisionTenant(ctx, 'rec');
    [examCell, chief] = await Promise.all([createStaff(ctx, t, ['EXAM_CELL_OPERATOR'], 'examcell'), createStaff(ctx, t, ['CHIEF_PROCTOR'], 'chief')]);
    const key = await createApiKey(ctx, t, ['roster:write']);
    const K = (p: string) => req().put(`/api/v1/integration/v1/roster/${p}/batch`).set('Authorization', `Bearer ${key.apiKey}`).set('Idempotency-Key', randomUUID()).set('X-ExamOS-Provider', 'uos');
    await K('academic-units').send({ rows: [{ kind: 'DEPARTMENT', code: 'ECE', name: 'ECE' }] });
    await K('courses').send({ rows: [{ code: 'EC201', name: 'Signals', departmentCode: 'ECE' }] });
    student.email = `s1@${t.slug}.test`;
    await K('persons').send({ rows: [{ externalId: 'UOS-5001', kind: 'STUDENT', fullName: 'Rec Student', email: student.email }] });
    await K('enrollments').send({ rows: [{ studentExternalId: 'UOS-5001', courseCode: 'EC201', academicYear: '2026-27', term: 'ODD' }] });
    const token = await activationTokenFor(ctx, t.tenantId, student.email);
    const act = await req().post('/api/v1/auth/activate').set('Host', t.host).send({ token, password: 'Student-Passw0rd!2026' });
    student.token = act.body.accessToken;

    const create = await req().post('/api/v1/exams').set(H(examCell.token)).send({ code: 'EC201-SEM', title: 'Signals — Semester', courseCode: 'EC201', examType: 'SEM_EXTERNAL', academicYear: '2026-27', semester: 3, securityProfile: 'SECURE_BYOD', durationMinutes: 90, windowStartAt: new Date(Date.now() - 60_000).toISOString(), windowEndAt: new Date(Date.now() + 4 * 3600_000).toISOString(), policy: { sebConfigKey: SEB_CONFIG_KEY } });
    examId = create.body.examId;
    await req().put(`/api/v1/exams/${examId}/paper`).set(H(examCell.token)).send({
      title: 'Signals Exam Paper',
      sections: [{ code: 'A', title: 'Main' }],
      questions: [{ questionId: 'q1', sectionCode: 'A', number: 1, kind: 'DESCRIPTIVE', prompt: { blocks: [{ id: 'p1', kind: 'paragraph', content: 'Explain Fourier transform.' }] }, maxMarks: 10, attachments: [] }],
    });
    await req().post(`/api/v1/exams/${examId}/paper/submit-for-review`).set(H(examCell.token));
    await req().post(`/api/v1/exams/${examId}/paper/approve`).set(H(examCell.token));

    await req().post(`/api/v1/exams/${examId}/allocations`).set(H(examCell.token)).send({ studentExternalIds: ['UOS-5001'], provider: 'uos' });
    for (const step of ['submit-for-review', 'approve', 'schedule', 'open-precheck']) await req().post(`/api/v1/exams/${examId}/${step}`).set(H(examCell.token));
    const mine = await req().get('/api/v1/student/me/exams').set(H(student.token));
    student.attemptId = mine.body.exams[0].attemptId;
  });
  afterAll(async () => ctx.close());

  it('exposes the readiness policy to the client (mandatory vs optional checks, consent purposes, notice)', async () => {
    const pol = await req().get(`/api/v1/student/attempts/${student.attemptId}/policy`).set(H(student.token));
    expect(pol.status).toBe(200);
    expect(pol.body.securityProfile).toBe('SECURE_BYOD');
    expect(pol.body.consentPurposes).toEqual(['CAMERA', 'MICROPHONE']);
    const canvas = pol.body.checks.find((c: { code: string }) => c.code === 'CANVAS_INPUT');
    expect(canvas.optional).toBe(true);
    expect(canvas.mandatory).toBe(false);
    expect(pol.body.monitoringNotice).toContain('never treated as misconduct');
  });

  it('verifies the Safe Exam Browser Config Key hash server-side; a browser without it must remediate', async () => {
    const start = await req().post(`/api/v1/student/attempts/${student.attemptId}/prechecks`).set(H(student.token)).send({ clientBuild: 'SEB_Win_3.8.0' });
    const runId = start.body.runId;
    const plain = await req().post(`/api/v1/student/prechecks/${runId}/items/verify`).set(H(student.token)).send({ code: 'CLIENT_VERSION', clientBuild: 'SEB_Win_3.8.0' });
    expect(plain.body.checks.find((c: { code: string }) => c.code === 'CLIENT_VERSION')).toMatchObject({ status: 'REMEDIATE', diagnosticCode: 'SEB_CONFIG_KEY_MISMATCH' });
    // SEB computes SHA-256(absolute request URL + Config Key) and sends it as X-SafeExamBrowser-ConfigKeyHash
    const url = `http://${t.host}/api/v1/student/prechecks/${runId}/items/verify`;
    const seb = await req().post(`/api/v1/student/prechecks/${runId}/items/verify`).set(H(student.token)).set('X-SafeExamBrowser-ConfigKeyHash', sha256Hex(`${url}${SEB_CONFIG_KEY}`)).send({ code: 'CLIENT_VERSION', clientBuild: 'SEB_Win_3.8.0' });
    expect(seb.body.checks.find((c: { code: string }) => c.code === 'CLIENT_VERSION')).toMatchObject({ status: 'PASS', source: 'SECURE_CLIENT' });
    const forged = await req().post(`/api/v1/student/prechecks/${runId}/items/verify`).set(H(student.token)).set('X-SafeExamBrowser-ConfigKeyHash', 'f'.repeat(64)).send({ code: 'CLIENT_VERSION', clientBuild: 'SEB_Win_3.8.0' });
    expect(forged.body.checks.find((c: { code: string }) => c.code === 'CLIENT_VERSION').status).toBe('REMEDIATE');
    // finish readiness
    const v = (body: Record<string, unknown>) => req().post(`/api/v1/student/prechecks/${runId}/items/verify`).set(H(student.token)).set('X-SafeExamBrowser-ConfigKeyHash', sha256Hex(`${url}${SEB_CONFIG_KEY}`)).send(body);
    await v({ code: 'CLIENT_VERSION', clientBuild: 'SEB_Win_3.8.0' });
    await v({ code: 'CLOCK_SYNC', clientClockMs: Date.now() });
    await v({ code: 'KEYBOARD_INPUT', keyboardSample: 'Signals and systems, chapter 2: 100 points!' });
    await req().post(`/api/v1/student/prechecks/${runId}/practice-saves`).set(H(student.token)).send({ contentDigest: 'c'.repeat(64) });
    await v({ code: 'NETWORK_SAVE_ROUNDTRIP' });
    const pol = await req().get(`/api/v1/student/attempts/${student.attemptId}/policy`).set(H(student.token));
    await v({ code: 'CONSENT', consentPolicyVersion: pol.body.policyVersion });
    const fin = await req().post(`/api/v1/student/prechecks/${runId}/finalize`).set(H(student.token));
    expect(fin.body.status).toBe('READY');
    await req().post(`/api/v1/exams/${examId}/start`).set(H(examCell.token));
    const g = await req().post(`/api/v1/student/attempts/${student.attemptId}/entry-grants`).set(H(student.token));
    const a = await req().post(`/api/v1/student/attempts/${student.attemptId}/admit`).set(H(student.token)).send({ grantToken: g.body.grantToken });
    expect(a.status).toBe(200);
    student.device = a.body.deviceSessionId;
  });

  it('a network drop moves the attempt to RECOVERY_PENDING without penalty; a Wi-Fi switch is logged, not flagged; reconnect restores it', async () => {
    const hb = await req().post(`/api/v1/student/attempts/${student.attemptId}/heartbeat`).set(H(student.token)).set('x-device-session', student.device).set('X-Forwarded-For', '10.0.0.5');
    expect(hb.status).toBe(200);
    // simulate 2 minutes of silence: age the heartbeat key
    await ctx.deps.redis.set(`attempt:heartbeat:${student.attemptId}`, String(Date.now() - 180_000));
    const moved = await withTenantTx(ctx.deps.db, t.tenantId, (trx) => sweepStaleHeartbeats(ctx.deps, trx, t.tenantId));
    expect(moved).toBe(1);
    const row = await ctx.admin('exam_attempts').where('id', student.attemptId).first();
    expect(row.status).toBe('RECOVERY_PENDING');
    const incidents = await ctx.admin('proctor_incidents').where({ attempt_id: student.attemptId });
    expect(incidents.length).toBe(0); // technical: never an incident, never a warning
    // writes are refused while recovery is pending; nothing is lost
    const blocked = await req().put(`/api/v1/student/attempts/${student.attemptId}/answers/Q1`).set(H(student.token)).set('x-device-session', student.device).send({ clientOperationId: randomUUID(), baseRevision: 0, answerFormat: 'hybrid-v1', ops: [{ op: 'upsert-block', blockId: 'b1', kind: 'paragraph', content: 'x' }], contentSha256: answerHash([{ id: 'b1', kind: 'paragraph', content: 'x' }]) });
    expect(blocked.status).toBe(409);
    // the student comes back on a different network address (hotspot) with the same device
    const back = await req().post(`/api/v1/student/attempts/${student.attemptId}/reconnect`).set(H(student.token)).set('x-device-session', student.device);
    expect(back.status).toBe(200);
    expect(back.body.status).toBe('ACTIVE');
    expect(back.body.deviceSessionId).toBe(student.device);
    const save = await req().put(`/api/v1/student/attempts/${student.attemptId}/answers/Q1`).set(H(student.token)).set('x-device-session', student.device).send({ clientOperationId: randomUUID(), baseRevision: 0, answerFormat: 'hybrid-v1', ops: [{ op: 'upsert-block', blockId: 'b1', kind: 'paragraph', content: 'x' }], contentSha256: answerHash([{ id: 'b1', kind: 'paragraph', content: 'x' }]) });
    expect(save.status).toBe(200);
    const events = await ctx.admin('attempt_event_log').where({ attempt_id: student.attemptId }).select('event_type');
    const types = events.map((e) => e.event_type);
    expect(types).toContain('attempt.recovery_pending');
    expect(types).toContain('attempt.reconnected');
  });

  it('a dead laptop is replaced through a technical hold and a resume that re-binds the device; the old device is then refused', async () => {
    const hold = await req().post(`/api/v1/proctor/attempts/${student.attemptId}/technical-holds`).set(H(chief.token)).send({ reasonCode: 'DEVICE_FAILURE', notes: 'laptop screen died, loaner issued', idempotencyKey: randomUUID() });
    expect(hold.status).toBe(200);
    expect(hold.body).toMatchObject({ attemptStatus: 'SUSPENDED', suspensionKind: 'TECHNICAL_HOLD' });
    const warnings = await ctx.admin('proctor_warnings').where('attempt_id', student.attemptId);
    expect(warnings.length).toBe(0);
    const resume = await req().post(`/api/v1/proctor/attempts/${student.attemptId}/resume`).set(H(chief.token)).send({ reasonCode: 'LOANER_ISSUED', notes: 'continue on loaner L-07', idempotencyKey: randomUUID(), deadlineExtensionMinutes: 10, rebindDevice: true });
    expect(resume.status).toBe(200);
    expect(resume.body.attemptStatus).toBe('ACTIVE');
    expect(resume.body.epoch.no).toBe(1); // a technical hold does not open a new warning epoch
    // first reconnect from the loaner binds it
    const loaner = randomUUID();
    const rc = await req().post(`/api/v1/student/attempts/${student.attemptId}/reconnect`).set(H(student.token)).set('x-device-session', loaner);
    expect(rc.status).toBe(200);
    expect(rc.body.deviceSessionId).toBe(loaner);
    expect(rc.body.answers).toEqual([{ questionId: 'Q1', serverRevision: 1, contentSha256: expect.any(String) }]);
    const old = await req().post(`/api/v1/student/attempts/${student.attemptId}/heartbeat`).set(H(student.token)).set('x-device-session', student.device);
    expect(old.status).toBe(409);
    expect(old.body.code).toBe('DEVICE_SESSION_MISMATCH');
    const concurrent = await ctx.admin('proctor_incidents').where({ attempt_id: student.attemptId, signal_class: 'CONCURRENT_SESSION' });
    expect(concurrent.length).toBe(1);
    const extended = await ctx.admin('exam_attempts').where('id', student.attemptId).first();
    expect(new Date(extended.deadline_at).getTime()).toBeGreaterThan(Date.now() + 90 * 60_000);
  });

  it('an expired admission exception no longer covers a check', async () => {
    const [row] = await ctx.admin('admission_exceptions').insert({ tenant_id: t.tenantId, attempt_id: student.attemptId, exception_code: 'POLICY_INCOMPATIBILITY', covers_checks: ['CLIENT_VERSION'], approved_by: chief.userId, reason: 'test', expires_at: new Date(Date.now() - 1000) }).returning('id');
    const board = await req().get(`/api/v1/exams/${examId}/readiness`).set(H(examCell.token));
    const cand = board.body.candidates.find((c: { attemptId: string }) => c.attemptId === student.attemptId);
    expect(cand.exceptions.some((e: { id: string }) => e.id === row.id)).toBe(false);
  });
});
