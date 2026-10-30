import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestContext, provisionTenant, createApiKey, startFakeServer, runWorkers, type TestContext, type ProvisionedTenant } from './helpers.js';
import { verifyWebhookSignature } from '../src/lib/crypto.js';

/** Review §5: the Simple Integration API — keys, scopes, idempotency, identity rules, events, signed webhooks. */
describe('Simple Integration API', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;
  let key: { apiKey: string; id: string };
  let receiver: { url: string; close: () => Promise<void> };
  const received: Array<{ headers: Record<string, string>; body: string }> = [];
  let failNext = 0;

  beforeAll(async () => {
    ctx = await createTestContext();
    t = await provisionTenant(ctx, 'erp');
    key = await createApiKey(ctx, t, ['roster:write', 'roster:read', 'events:read', 'results:read', 'webhooks:manage']);
    receiver = await startFakeServer((app) => {
      app.post('/hook', (req, res) => {
        if (failNext > 0) {
          failNext--;
          return res.status(503).end();
        }
        received.push({ headers: req.headers as Record<string, string>, body: JSON.stringify(req.body) });
        res.status(204).end();
      });
    });
  });
  afterAll(async () => {
    await receiver.close();
    await ctx.close();
  });

  const call = () => ctx.request();

  it('rejects malformed, wrong and under-scoped keys without leaking which part failed', async () => {
    const bad = await call().put('/api/v1/integration/v1/roster/persons/batch').set('Authorization', 'Bearer nope').send({ rows: [] });
    expect(bad.status).toBe(401);
    const wrong = await call().put('/api/v1/integration/v1/roster/persons/batch').set('Authorization', `Bearer ${key.apiKey.slice(0, -4)}abcd`).send({ rows: [] });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('API_KEY_INVALID');
    const narrow = await createApiKey(ctx, t, ['events:read']);
    const scoped = await call().put('/api/v1/integration/v1/roster/persons/batch').set('Authorization', `Bearer ${narrow.apiKey}`).set('Idempotency-Key', randomUUID()).send({ rows: [{ externalId: 'S1', kind: 'STUDENT', fullName: 'A', email: `a@${t.slug}.test` }] });
    expect(scoped.status).toBe(403);
    expect(scoped.body.code).toBe('SCOPE_MISSING');
  });

  it('syncs academic units, courses, persons and enrolments in canonical shape with per-row outcomes', async () => {
    const units = await call()
      .put('/api/v1/integration/v1/roster/academic-units/batch')
      .set('Authorization', `Bearer ${key.apiKey}`)
      .set('Idempotency-Key', randomUUID())
      .set('X-ExamOS-Provider', 'uos')
      .send({ rows: [{ kind: 'DEPARTMENT', code: 'CSE', name: 'Computer Science', parentCode: 'SOE' }, { kind: 'PROGRAMME', code: 'BTECH-CSE', name: 'B.Tech CSE', parentCode: 'CSE' }] });
    expect(units.status).toBe(200);
    expect(units.body.summary.created).toBe(2);
    const courses = await call().put('/api/v1/integration/v1/roster/courses/batch').set('Authorization', `Bearer ${key.apiKey}`).set('Idempotency-Key', randomUUID()).set('X-ExamOS-Provider', 'uos').send({ rows: [{ code: 'CS301', name: 'Operating Systems', departmentCode: 'CSE', credits: 4 }, { code: 'XX1', name: 'Orphan', departmentCode: 'NOPE' }] });
    expect(courses.status).toBe(200);
    expect(courses.body.summary.created).toBe(1);
    expect(courses.body.rows[1].outcome).toBe('REJECTED');
    expect(courses.body.rows[1].code).toBe('DEPARTMENT_NOT_FOUND');

    const persons = await call()
      .put('/api/v1/integration/v1/roster/persons/batch')
      .set('Authorization', `Bearer ${key.apiKey}`)
      .set('Idempotency-Key', randomUUID())
      .set('X-ExamOS-Provider', 'uos')
      .send({
        rows: [
          { externalId: 'UOS-1001', kind: 'STUDENT', fullName: 'Asha Rao', email: `asha@${t.slug}.test`, departmentCode: 'CSE', programmeCode: 'BTECH-CSE', currentSemester: 5, section: 'A', attributes: { registerNumber: '22CSE001' } },
          { externalId: 'UOS-1002', kind: 'STUDENT', fullName: 'Bala K', email: `bala@${t.slug}.test`, departmentCode: 'CSE', currentSemester: 5, section: 'A' },
        ],
      });
    expect(persons.status).toBe(200);
    expect(persons.body.summary).toMatchObject({ created: 2, identityConflicts: 0 });
    const enrol = await call()
      .put('/api/v1/integration/v1/roster/enrollments/batch')
      .set('Authorization', `Bearer ${key.apiKey}`)
      .set('Idempotency-Key', randomUUID())
      .set('X-ExamOS-Provider', 'uos')
      .send({ rows: [{ studentExternalId: 'UOS-1001', courseCode: 'CS301', academicYear: '2026-27', term: 'ODD' }, { studentExternalId: 'UOS-9999', courseCode: 'CS301', academicYear: '2026-27', term: 'ODD' }] });
    expect(enrol.status).toBe(200);
    expect(enrol.body.rows[0].outcome).toBe('CREATED');
    expect(enrol.body.rows[1].code).toBe('STUDENT_NOT_FOUND');
    const prof = await ctx.admin('student_profiles as sp').join('users as u', 'u.id', 'sp.user_id').where({ 'u.tenant_id': t.tenantId, 'u.email': `asha@${t.slug}.test` }).first('sp.register_number', 'sp.current_semester');
    expect(prof.register_number).toBe('22CSE001');
    expect(prof.current_semester).toBe(5);
  });

  it('is idempotent: same key + same body replays; same key + different body is 409', async () => {
    const idem = randomUUID();
    const body = { rows: [{ externalId: 'UOS-1003', kind: 'STUDENT', fullName: 'Chitra', email: `chitra@${t.slug}.test` }] };
    const r1 = await call().put('/api/v1/integration/v1/roster/persons/batch').set('Authorization', `Bearer ${key.apiKey}`).set('Idempotency-Key', idem).set('X-ExamOS-Provider', 'uos').send(body);
    expect(r1.status).toBe(200);
    const r2 = await call().put('/api/v1/integration/v1/roster/persons/batch').set('Authorization', `Bearer ${key.apiKey}`).set('Idempotency-Key', idem).set('X-ExamOS-Provider', 'uos').send(body);
    expect(r2.status).toBe(200);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(r2.body.syncJobId).toBe(r1.body.syncJobId);
    const r3 = await call().put('/api/v1/integration/v1/roster/persons/batch').set('Authorization', `Bearer ${key.apiKey}`).set('Idempotency-Key', idem).set('X-ExamOS-Provider', 'uos').send({ rows: [{ ...body.rows[0], fullName: 'Different' }] });
    expect(r3.status).toBe(409);
    expect(r3.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const users = await ctx.admin('users').where({ tenant_id: t.tenantId, email: `chitra@${t.slug}.test` });
    expect(users.length).toBe(1);
  });

  it('never merges people by e-mail: a new external id with an existing e-mail halts as IDENTITY_CONFLICT', async () => {
    const r = await call().put('/api/v1/integration/v1/roster/persons/batch').set('Authorization', `Bearer ${key.apiKey}`).set('Idempotency-Key', randomUUID()).set('X-ExamOS-Provider', 'uos').send({ rows: [{ externalId: 'UOS-2001', kind: 'STUDENT', fullName: 'Asha Clone', email: `asha@${t.slug}.test` }] });
    expect(r.status).toBe(200);
    expect(r.body.rows[0].outcome).toBe('IDENTITY_CONFLICT');
    expect(r.body.summary.identityConflicts).toBe(1);
    const job = await call().get(`/api/v1/integration/v1/roster/sync-jobs/${r.body.syncJobId}`).set('Authorization', `Bearer ${key.apiKey}`);
    expect(job.status).toBe(200);
    expect(job.body.job.status).toBe('COMPLETED_WITH_ERRORS');
  });

  it('updates in place and reports UNCHANGED on a no-op upsert', async () => {
    const r1 = await call().put('/api/v1/integration/v1/roster/persons/batch').set('Authorization', `Bearer ${key.apiKey}`).set('Idempotency-Key', randomUUID()).set('X-ExamOS-Provider', 'uos').send({ rows: [{ externalId: 'UOS-1002', kind: 'STUDENT', fullName: 'Bala Krishnan', email: `bala@${t.slug}.test` }] });
    expect(r1.body.rows[0].outcome).toBe('UPDATED');
    const r2 = await call().put('/api/v1/integration/v1/roster/persons/batch').set('Authorization', `Bearer ${key.apiKey}`).set('Idempotency-Key', randomUUID()).set('X-ExamOS-Provider', 'uos').send({ rows: [{ externalId: 'UOS-1002', kind: 'STUDENT', fullName: 'Bala Krishnan', email: `bala@${t.slug}.test` }] });
    expect(r2.body.rows[0].outcome).toBe('UNCHANGED');
  });

  it('serves the event feed by cursor and delivers signed webhooks with retry and dead-letter', async () => {
    await runWorkers(ctx); // flush outbox events recorded before any endpoint existed
    const hook = await call().post('/api/v1/integration/v1/webhooks').set('Authorization', `Bearer ${key.apiKey}`).send({ url: `${receiver.url}/hook`, eventTypes: ['roster.sync.completed', 'result.published'] });
    expect(hook.status).toBe(201);
    const secret = hook.body.signingSecret as string;
    expect(secret.startsWith('whsec_')).toBe(true);

    const before = received.length;
    await call().put('/api/v1/integration/v1/roster/persons/batch').set('Authorization', `Bearer ${key.apiKey}`).set('Idempotency-Key', randomUUID()).set('X-ExamOS-Provider', 'uos').send({ rows: [{ externalId: 'UOS-1004', kind: 'STUDENT', fullName: 'Deepa', email: `deepa@${t.slug}.test` }] });
    await runWorkers(ctx);
    expect(received.length).toBe(before + 1);
    const d = received[received.length - 1]!;
    const sig = d.headers['x-examos-signature']!;
    expect(verifyWebhookSignature(secret, d.body, sig)).toBe(true);
    expect(verifyWebhookSignature('whsec_wrong', d.body, sig)).toBe(false);
    const env = JSON.parse(d.body);
    expect(env.type).toBe('roster.sync.completed');
    expect(env.tenantId).toBe(t.tenantId);
    expect(env.version).toBe(1);

    // feed
    const feed = await call().get('/api/v1/integration/v1/events').set('Authorization', `Bearer ${key.apiKey}`).query({ limit: 2 });
    expect(feed.status).toBe(200);
    expect(feed.body.events.length).toBe(2);
    expect(feed.body.nextCursor).toBeTruthy();
    const page2 = await call().get('/api/v1/integration/v1/events').set('Authorization', `Bearer ${key.apiKey}`).query({ since: feed.body.nextCursor, limit: 100 });
    expect(page2.status).toBe(200);
    expect(page2.body.events.every((e: { cursor: string }) => Number(e.cursor) > Number(feed.body.nextCursor))).toBe(true);

    // retry: endpoint fails twice, then a replay succeeds
    failNext = 2;
    await call().put('/api/v1/integration/v1/roster/persons/batch').set('Authorization', `Bearer ${key.apiKey}`).set('Idempotency-Key', randomUUID()).set('X-ExamOS-Provider', 'uos').send({ rows: [{ externalId: 'UOS-1005', kind: 'STUDENT', fullName: 'Esha', email: `esha@${t.slug}.test` }] });
    const w1 = await runWorkers(ctx);
    expect(w1.webhooks.retried).toBe(1);
    const retrying = await ctx.admin('webhook_deliveries').where({ tenant_id: t.tenantId, status: 'RETRYING' });
    expect(retrying.length).toBe(1);
    expect(new Date(retrying[0].next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 30_000);
    // admin replay brings it forward; the endpoint fails once more then succeeds
    const replay = await call().post(`/api/v1/tenant/webhooks/deliveries/${retrying[0].id}/replay`).set('Host', t.host).set('Authorization', `Bearer ${t.admin.token}`);
    expect(replay.status).toBe(202);
    await runWorkers(ctx); // fails (failNext=1)
    await call().post(`/api/v1/tenant/webhooks/deliveries/${retrying[0].id}/replay`).set('Host', t.host).set('Authorization', `Bearer ${t.admin.token}`);
    const w3 = await runWorkers(ctx);
    expect(w3.webhooks.delivered).toBe(1);
    const done = await ctx.admin('webhook_deliveries').where({ id: retrying[0].id }).first();
    expect(done.status).toBe('DELIVERED');
  });

  it('exposes tenant admin views of deliveries and api keys, and revocation takes effect immediately', async () => {
    const list = await call().get('/api/v1/tenant/webhooks/deliveries').set('Host', t.host).set('Authorization', `Bearer ${t.admin.token}`);
    expect(list.status).toBe(200);
    expect(list.body.deliveries.length).toBeGreaterThan(0);
    const temp = await createApiKey(ctx, t, ['events:read']);
    const ok = await call().get('/api/v1/integration/v1/events').set('Authorization', `Bearer ${temp.apiKey}`);
    expect(ok.status).toBe(200);
    const del = await call().delete(`/api/v1/tenant/api-keys/${temp.id}`).set('Host', t.host).set('Authorization', `Bearer ${t.admin.token}`);
    expect(del.status).toBe(204);
    const denied = await call().get('/api/v1/integration/v1/events').set('Authorization', `Bearer ${temp.apiKey}`);
    expect(denied.status).toBe(401);
    expect(denied.body.code).toBe('API_KEY_REVOKED');
  });
});
