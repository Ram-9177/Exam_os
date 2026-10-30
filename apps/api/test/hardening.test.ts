import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestContext, provisionTenant, createStaff, createApiKey, activationTokenFor, answerHash, cleanScan, type TestContext, type ProvisionedTenant } from './helpers.js';
import { sweepExpiredAttempts } from '../src/modules/exams/service.js';
import { runForensicsOnce } from '../src/modules/candidates/service.js';

/**
 * Audit follow-ups that a strict examiner checks before go-live: the server
 * validates every answer block it stores, tenant admins cannot point a
 * transport at the deployment's own secrets, a download never rewrites an exam
 * policy, scripts are not readable through the JSON booklet while the exam is
 * being written, a hold never strands a candidate, and a student whose own
 * deadline passed is sealed by the server and receives a receipt.
 */
describe('exam-day hardening', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;
  let examCell: Awaited<ReturnType<typeof createStaff>>;
  let evaluator: Awaited<ReturnType<typeof createStaff>>;
  let examId = '';
  const PASSWORD = 'Student-Passw0rd!2026';
  interface Student { externalId: string; email: string; token: string; attemptId: string; device: string }
  const students: Student[] = [];
  const H = (token: string, ip = '10.30.0.1') => ({ Host: t.host, Authorization: `Bearer ${token}`, 'X-Forwarded-For': ip, 'User-Agent': 'ExamOS-Test/1.0' });
  const req = () => ctx.request();
  const save = (s: Student, q: string, blocks: Array<{ id: string; kind: string; content: unknown }>, baseRevision = 0) =>
    req().put(`/api/v1/student/attempts/${s.attemptId}/answers/${q}`).set(H(s.token)).set('x-device-session', s.device).send({ clientOperationId: randomUUID(), baseRevision, answerFormat: 'hybrid-v1', ops: blocks.map((b) => ({ op: 'upsert-block', blockId: b.id, kind: b.kind, content: b.content })), contentSha256: answerHash(blocks) });

  beforeAll(async () => {
    ctx = await createTestContext();
    t = await provisionTenant(ctx, 'hard');
    [examCell, evaluator] = await Promise.all([createStaff(ctx, t, ['EXAM_CELL_OPERATOR', 'CHIEF_PROCTOR'], 'examcell'), createStaff(ctx, t, ['EVALUATOR'], 'evaluator')]);
    const key = await createApiKey(ctx, t, ['roster:write']);
    const K = (p: string) => req().put(`/api/v1/integration/v1/roster/${p}/batch`).set('Authorization', `Bearer ${key.apiKey}`).set('Idempotency-Key', randomUUID()).set('X-ExamOS-Provider', 'uos');
    await K('academic-units').send({ rows: [{ kind: 'DEPARTMENT', code: 'HD', name: 'Hardening' }] });
    await K('courses').send({ rows: [{ code: 'HD101', name: 'Hardening 101', departmentCode: 'HD' }] });
    const people = Array.from({ length: 3 }, (_, i) => ({ externalId: `UOS-8${String(i).padStart(3, '0')}`, kind: 'STUDENT' as const, fullName: `Hard ${i}`, email: `h${i}@${t.slug}.test` }));
    await K('persons').send({ rows: people });
    await K('enrollments').send({ rows: people.map((p) => ({ studentExternalId: p.externalId, courseCode: 'HD101', academicYear: '2026-27', term: 'ODD' })) });
    const create = await req().post('/api/v1/exams').set(H(examCell.token)).send({ code: 'HD101-A', title: 'Hardening A', courseCode: 'HD101', examType: 'MID_1', academicYear: '2026-27', semester: 1, securityProfile: 'BASIC_BROWSER', durationMinutes: 60, windowStartAt: new Date(Date.now() - 60_000).toISOString(), windowEndAt: new Date(Date.now() + 4 * 3600_000).toISOString() });
    examId = create.body.examId;
    await req().put(`/api/v1/exams/${examId}/paper`).set(H(examCell.token)).send({ title: 'Paper', sections: [{ code: 'A', title: 'Main' }], questions: [{ questionId: 'Q1', sectionCode: 'A', number: 1, kind: 'DESCRIPTIVE', prompt: { blocks: [{ id: 'p1', kind: 'paragraph', content: 'Describe paging.' }] }, maxMarks: 10, attachments: [] }] });
    await req().post(`/api/v1/exams/${examId}/paper/submit-for-review`).set(H(examCell.token));
    await req().post(`/api/v1/exams/${examId}/paper/approve`).set(H(examCell.token));
    await req().post(`/api/v1/exams/${examId}/allocations`).set(H(examCell.token)).send({ studentExternalIds: people.map((p) => p.externalId), provider: 'uos' });
    for (const step of ['submit-for-review', 'approve', 'schedule', 'open-precheck']) await req().post(`/api/v1/exams/${examId}/${step}`).set(H(examCell.token));
    for (const [i, p] of people.entries()) {
      const token = await activationTokenFor(ctx, t.tenantId, p.email);
      const act = await req().post('/api/v1/auth/activate').set('Host', t.host).set('X-Forwarded-For', `10.31.0.${i + 1}`).send({ token, password: PASSWORD });
      const s: Student = { externalId: p.externalId, email: p.email, token: act.body.accessToken, attemptId: '', device: '' };
      const mine = await req().get('/api/v1/student/me/exams').set(H(s.token));
      s.attemptId = (mine.body.exams as Array<{ examId: string; attemptId: string }>).find((e) => e.examId === examId)!.attemptId;
      const start = await req().post(`/api/v1/student/attempts/${s.attemptId}/prechecks`).set(H(s.token)).send({ clientBuild: 'chrome-130' });
      const v = (body: Record<string, unknown>) => req().post(`/api/v1/student/prechecks/${start.body.runId}/items/verify`).set(H(s.token)).send(body);
      await v({ code: 'CLOCK_SYNC', clientClockMs: Date.now() });
      await v({ code: 'KEYBOARD_INPUT', keyboardSample: 'Paging removes external fragmentation, 100%!' });
      await v({ code: 'SYSTEM_SCAN', scan: cleanScan() });
      await req().post(`/api/v1/student/prechecks/${start.body.runId}/practice-saves`).set(H(s.token)).send({ contentDigest: 'a'.repeat(64) });
      await v({ code: 'NETWORK_SAVE_ROUNDTRIP' });
      expect((await req().post(`/api/v1/student/prechecks/${start.body.runId}/finalize`).set(H(s.token))).body.status).toBe('READY');
      students.push(s);
    }
    await req().post(`/api/v1/exams/${examId}/start`).set(H(examCell.token));
    for (const s of students) {
      const g = await req().post(`/api/v1/student/attempts/${s.attemptId}/entry-grants`).set(H(s.token));
      const a = await req().post(`/api/v1/student/attempts/${s.attemptId}/admit`).set(H(s.token)).send({ grantToken: g.body.grantToken });
      expect(a.status).toBe(200);
      s.device = a.body.deviceSessionId;
    }
  }, 90_000);
  afterAll(async () => ctx.close());

  it('validates every answer block it stores: malformed drawings and oversized paragraphs are refused, nothing is written', async () => {
    const s = students[0]!;
    const evil = await save(s, 'Q1', [{ id: 'c1', kind: 'canvas', content: { width: 400, height: 300, strokes: [{ tool: 'pen', width: 2, points: [['"/><script>alert(1)</script><path d="', 0], [5, 5]] }] } }]);
    expect(evil.status).toBe(422);
    expect(evil.body.code).toBe('ANSWER_INVALID');
    const tooMany = await save(s, 'Q1', [{ id: 'c2', kind: 'canvas', content: { width: 400, height: 300, strokes: [{ tool: 'pen', width: 2, points: Array.from({ length: 6001 }, (_, i) => [i % 400, (i * 7) % 300]) }] } }]);
    expect(tooMany.status).toBe(422);
    const longText = await save(s, 'Q1', [{ id: 'p1', kind: 'paragraph', content: 'x'.repeat(50_001) }]);
    expect(longText.status).toBe(422);
    expect(longText.body.code).toBe('ANSWER_TOO_LARGE');
    const notText = await save(s, 'Q1', [{ id: 'p1', kind: 'paragraph', content: { nested: true } }]);
    expect(notText.status).toBe(422);
    const noKind = await req().put(`/api/v1/student/attempts/${s.attemptId}/answers/Q1`).set(H(s.token)).set('x-device-session', s.device).send({ clientOperationId: randomUUID(), baseRevision: 0, answerFormat: 'hybrid-v1', ops: [{ op: 'upsert-block', blockId: 'new', content: 'x' }], contentSha256: answerHash([{ id: 'new', kind: 'paragraph', content: 'x' }]) });
    expect([400, 422]).toContain(noKind.status);
    expect(await ctx.admin('answer_revisions').where({ attempt_id: s.attemptId })).toHaveLength(0);
    // a legal drawing and paragraph go through, and the stored document is canonical
    const ok = await save(s, 'Q1', [{ id: 'p1', kind: 'paragraph', content: 'Paging maps pages to frames.' }, { id: 'c1', kind: 'canvas', content: { width: 400, height: 300, background: 'grid', strokes: [{ tool: 'rect', width: 2, color: 'blue', fill: true, points: [[10, 10], [100, 60]] }, { tool: 'text', width: 1, points: [[20, 200]], text: 'frame', size: 18 }] } }]);
    expect(ok.status).toBe(200);
    expect(ok.body.serverRevision).toBe(1);
  });

  it('a tenant admin cannot point a mail or SSO transport at the deployment\'s own secrets', async () => {
    const mail = await req().put('/api/v1/tenant/mail-config').set(H(t.admin.token)).send({ transportKind: 'power-automate', senderAddress: `exam@${t.slug}.test`, senderName: 'Exam Cell', endpointRef: 'env:JWT_PRIVATE_KEY_PEM', tokenRef: 'env:DATABASE_URL' });
    expect(`${mail.status} ${mail.body.code}`).toBe('422 SECRET_REF_NOT_ALLOWED');
    const sso = await req().put('/api/v1/tenant/sso-config').set(H(t.admin.token)).send({ provider: 'entra', issuer: 'https://login.microsoftonline.com/common/v2.0', clientId: 'client', clientSecretRef: 'vault:anything', allowedEmailDomains: [`${t.slug}.test`] });
    expect(sso.status).toBe(422);
    expect(sso.body.code).toBe('SECRET_REF_NOT_ALLOWED');
    expect(await ctx.admin('tenant_sso_configs').where({ tenant_id: t.tenantId })).toHaveLength(0);
  });

  it('downloading a Safe Exam Browser configuration never generates one (a GET must not rewrite the exam policy)', async () => {
    const before = (await ctx.admin('exams').where('id', examId).first('policy')).policy;
    const staff = await req().get(`/api/v1/exams/${examId}/seb-config`).set(H(examCell.token));
    expect(staff.status).toBe(404);
    expect(staff.body.code).toBe('SEB_CONFIG_NOT_GENERATED');
    const student = await req().get(`/api/v1/student/me/exams/${examId}/seb-config`).set(H(students[0]!.token));
    expect(student.status).toBe(404);
    expect((await ctx.admin('exams').where('id', examId).first('policy')).policy).toEqual(before);
  });

  it('the JSON booklet is read by permission and never while the exam is being written; students see it only after publication', async () => {
    // a script exists only once the attempt is sealed: student 2 submits early while the exam stays LIVE
    const s = students[2]!;
    const submit = await req().post(`/api/v1/student/attempts/${s.attemptId}/submit`).set(H(s.token)).set('x-device-session', s.device).send({ idempotencyKey: randomUUID() });
    expect(submit.status).toBe(200);
    const evaluatorRead = await req().get(`/api/v1/student/attempts/${s.attemptId}/booklet`).set(H(evaluator.token));
    expect(evaluatorRead.status).toBe(403);
    expect(evaluatorRead.body.code).toBe('EXPORT_LOCKED');
    expect(await ctx.admin('audit_events').where({ tenant_id: t.tenantId, action: 'export.blocked' })).toHaveLength(1);
    const own = await req().get(`/api/v1/student/attempts/${s.attemptId}/booklet`).set(H(s.token));
    expect(own.status).toBe(409);
    expect(own.body.code).toBe('NOT_PUBLISHED');
    const other = await req().get(`/api/v1/student/attempts/${s.attemptId}/booklet`).set(H(students[1]!.token));
    expect(other.status).toBe(404);
  });

  it('in-exam endpoints are rate limited per student', async () => {
    const s = students[0]!;
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await req().post(`/api/v1/student/attempts/${s.attemptId}/device-scans`).set(H(s.token)).send({ scan: cleanScan() })).status;
    expect(last).toBe(429);
  });

  it('a student whose own deadline passed is sealed by the server, keeps every acknowledged answer, and gets the receipt through the heartbeat', async () => {
    const s = students[1]!;
    expect((await save(s, 'Q1', [{ id: 'p1', kind: 'paragraph', content: 'written in time' }])).status).toBe(200);
    await ctx.admin('exam_attempts').where('id', s.attemptId).update({ deadline_at: new Date(Date.now() - 120_000) });
    const late = await save(s, 'Q1', [{ id: 'p1', kind: 'paragraph', content: 'written after time' }], 1);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('DEADLINE_PASSED');
    // the exam is still LIVE for the others; only this attempt is sealed
    expect(await sweepExpiredAttempts(ctx.deps)).toEqual({ sealed: 1 });
    expect(await sweepExpiredAttempts(ctx.deps)).toEqual({ sealed: 0 });
    const row = await ctx.admin('exam_attempts').where('id', s.attemptId).first('status');
    expect(row.status).toBe('EXPIRED');
    const manifest = await ctx.admin('submission_manifests').where({ attempt_id: s.attemptId }).first();
    expect(manifest).toBeTruthy();
    expect((manifest.manifest as { answers: Array<{ questionId: string; revision: number }> }).answers).toEqual([{ questionId: 'Q1', revision: 1, sha256: expect.any(String) }]);
    const hb = await req().post(`/api/v1/student/attempts/${s.attemptId}/heartbeat`).set(H(s.token)).set('x-device-session', s.device);
    expect(hb.status).toBe(200);
    expect(hb.body.status).toBe('EXPIRED');
    expect(hb.body.receipt).toMatchObject({ receiptId: manifest.receipt_id, manifestSha256: manifest.manifest_sha256 });
    expect((await ctx.admin('exam_attempts').where('id', students[0]!.attemptId).first('status')).status).toBe('ACTIVE');
  });

  it('a hold placed before marks exist can always be released back into the marking queue', async () => {
    const s = students[2]!; // sealed in the booklet test above
    const forensics = await req().post(`/api/v1/candidates/${s.attemptId}/forensics/run`).set(H(examCell.token));
    expect(forensics.status).toBeLessThan(300);
    const packet = () => ctx.admin('candidate_review_packets').where({ attempt_id: s.attemptId }).first('status');
    expect((await packet()).status).toBe('ACADEMIC_MARKING_READY'); // clean checks route straight to marking
    const hold = await req().post(`/api/v1/candidates/${s.attemptId}/holds`).set(H(examCell.token)).send({ status: 'INTEGRITY_HOLD', reason: 'similar answers flagged for review' });
    expect(hold.status).toBeLessThan(300);
    expect((await packet()).status).toBe('INTEGRITY_HOLD');
    const release = await req().post(`/api/v1/candidates/${s.attemptId}/holds/release`).set(H(examCell.token)).send({ reason: 'reviewed with the department; no case to answer' });
    expect(release.status).toBeLessThan(300);
    expect((await packet()).status).toBe('ACADEMIC_MARKING_READY');
  });
  it('the forensics lane routes a packet whose checks throw to technical review and still processes the next packet', async () => {
    // student 1 was sealed by the deadline sweep, student 0 submits now: two ATTEMPT_SEALED packets, oldest first
    const poisoned = students[1]!;
    const healthy = students[0]!;
    const submit = await req().post(`/api/v1/student/attempts/${healthy.attemptId}/submit`).set(H(healthy.token)).set('x-device-session', healthy.device).send({ idempotencyKey: randomUUID() });
    expect(submit.status).toBe(200);
    const packet = (attemptId: string) => ctx.admin('candidate_review_packets').where({ attempt_id: attemptId }).first();
    expect((await packet(poisoned.attemptId)).status).toBe('ATTEMPT_SEALED');
    expect((await packet(healthy.attemptId)).status).toBe('ATTEMPT_SEALED');
    expect(new Date((await packet(poisoned.attemptId)).created_at).getTime()).toBeLessThanOrEqual(new Date((await packet(healthy.attemptId)).created_at).getTime());
    // Simulate a corrupt sealed manifest (e.g. restored from a bad backup) so the checks themselves throw.
    // submission_manifests is append-only; only this test bypasses the trigger, as a superuser, to plant the corruption.
    await ctx.admin.transaction(async (trx) => {
      await trx.raw('SET LOCAL session_replication_role = replica');
      await trx('submission_manifests').where({ attempt_id: poisoned.attemptId }).update({ manifest: JSON.stringify({ answers: 'corrupt' }) });
    });

    const processed = await runForensicsOnce(ctx.deps);
    expect(processed).toBeGreaterThanOrEqual(2);
    const bad = await packet(poisoned.attemptId);
    expect(bad.status).toBe('TECHNICAL_REVIEW_REQUIRED');
    expect(bad.hold_reason).toMatch(/^FORENSICS_FAILED: /);
    const failedEvents = await ctx.admin('attempt_event_log').where({ attempt_id: poisoned.attemptId, event_type: 'forensics.failed' });
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].actor).toBe('SYSTEM:forensics');
    // the lane moved on: the packet after the poisoned one was checked and reached the marking queue
    expect((await packet(healthy.attemptId)).status).toBe('ACADEMIC_MARKING_READY');

    // the poisoned packet is no longer picked up, so the lane cannot loop on it
    const before = (await packet(poisoned.attemptId)).version;
    await runForensicsOnce(ctx.deps);
    const after = await packet(poisoned.attemptId);
    expect(after.status).toBe('TECHNICAL_REVIEW_REQUIRED');
    expect(after.version).toBe(before);
    expect(await ctx.admin('attempt_event_log').where({ attempt_id: poisoned.attemptId, event_type: 'forensics.failed' })).toHaveLength(1);
  });
});
