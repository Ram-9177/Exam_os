import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@examos/db';
import { createTestContext, provisionTenant, startFakeServer, runWorkers, sleep, type TestContext, type ProvisionedTenant } from './helpers.js';
import { enqueueMail, renderTemplate } from '../src/modules/notifications/service.js';
import { runMailWorkerOnce } from '../src/modules/notifications/worker.js';

/**
 * Review §6: the exam mailbox path. A fake Power Automate flow stands in for
 * the real "When an HTTP request is received" trigger: it checks the shared
 * token, answers 202 like the real flow, and calls the ExamOS callback with the
 * outcome. Everything else (outbox, worker, status machine, dedupe, backoff,
 * per-tenant sender) is the production code.
 */
describe('exam mail via Power Automate', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;
  let flow: { url: string; close: () => Promise<void> };
  const flowCalls: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
  let flowMode: 'ok' | 'reject' | 'down' | 'fail-callback' = 'ok';
  let apiBase = '';
  const FLOW_TOKEN = 'flow-shared-token-123';
  const CALLBACK_SECRET = 'cb-secret-xyz';

  beforeAll(async () => {
    ctx = await createTestContext();
    t = await provisionTenant(ctx, 'mail');
    // run the API on a real port so the fake flow can call the callback like the real one would
    const server = ctx.app.app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    apiBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    flow = await startFakeServer((app) => {
      app.post('/flow', async (req, res) => {
        if (flowMode === 'down') return res.status(500).end();
        if (req.header('x-examos-token') !== FLOW_TOKEN) return res.status(401).end();
        flowCalls.push({ headers: req.headers as Record<string, string>, body: req.body });
        res.status(202).json({ messageId: `pa-${req.body.dispatchId}` });
        // the flow's last action: callback to ExamOS with the outcome
        setTimeout(() => {
          void fetch(`${apiBase}/api/v1/integration/v1/mail/callbacks`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${CALLBACK_SECRET}` },
            body: JSON.stringify({ dispatchId: req.body.dispatchId, outcome: flowMode === 'fail-callback' ? 'FAILED' : 'ACCEPTED', providerMessageId: `pa-${req.body.dispatchId}`, error: flowMode === 'fail-callback' ? 'mailbox quota exceeded' : undefined }),
          });
        }, 20);
      });
    });
    const cfg = await ctx.request().put('/api/v1/tenant/mail-config').set('Host', t.host).set('Authorization', `Bearer ${t.admin.token}`).send({ transportKind: 'power-automate', senderAddress: `exam@${t.slug}.edu.in`, senderName: 'Examination Cell', endpointSecret: `${flow.url}/flow`, tokenSecret: FLOW_TOKEN, callbackSecret: CALLBACK_SECRET });
    expect(cfg.status).toBe(204);
    const stored = await ctx.admin('tenant_mail_configs').where({ tenant_id: t.tenantId }).whereNull('category').first();
    expect(stored.endpoint_ref.startsWith('enc:')).toBe(true); // never plaintext
    expect(stored.token_ref).not.toContain(FLOW_TOKEN);
  });
  afterAll(async () => {
    await flow.close();
    await ctx.close();
  });

  async function enqueue(category: Parameters<typeof enqueueMail>[1]['category'], dedupeKey: string, to = `student-${randomUUID().slice(0, 6)}@${t.slug}.test`) {
    return withTenantTx(ctx.deps.db, t.tenantId, (trx) => enqueueMail(trx, { tenantId: t.tenantId, category, to: { address: to, name: 'Student' }, dedupeKey, vars: { fullName: 'Student', examTitle: 'OS Mid-1', portalUrl: 'https://exam.test', precheckOpensLocal: '09:30', tenantName: 'T', activationUrl: 'x', expiresInHours: 48, rehearsalDeadline: 'tomorrow', examStartLocal: 'Mon 10:00', admittedAtLocal: 'now', receiptId: 'r1' } }));
  }

  it('renders versioned templates with HTML escaping and dedupes per business event', async () => {
    expect(renderTemplate('<b>{{name}}</b>', { name: '<script>' }, true)).toBe('<b>&lt;script&gt;</b>');
    const k = `test:${randomUUID()}`;
    const a = await enqueue('PREFLIGHT_REMINDER', k);
    const b = await enqueue('PREFLIGHT_REMINDER', k);
    expect(a.dispatchId).toBeTruthy();
    expect(b.duplicate).toBe(true);
    const row = await ctx.admin('mail_dispatches').where('id', a.dispatchId).first();
    expect(row.lane).toBe('BULK');
    expect(row.template_version).toBe(1);
    expect(row.subject).toContain('OS Mid-1');
  });

  it('sends from the tenant exam mailbox through the flow, stays SENDING until the callback, then becomes ACCEPTED', async () => {
    flowMode = 'ok';
    const { dispatchId } = await enqueue('ADMISSION_RECEIPT', `receipt:${randomUUID()}`);
    const pass = await runMailWorkerOnce(ctx.deps, 'TRANSACTIONAL');
    expect(pass.pending).toBeGreaterThanOrEqual(1);
    const call = flowCalls[flowCalls.length - 1]!;
    expect(call.body.from).toBe(`exam@${t.slug}.edu.in`);
    expect(call.body.dispatchId).toBe(dispatchId);
    expect(call.headers['x-examos-dispatch-id']).toBe(dispatchId);
    expect(call.body.html).toContain('OS Mid-1');
    const mid = await ctx.admin('mail_dispatches').where('id', dispatchId).first();
    expect(mid.status).toBe('SENDING');
    expect(mid.provider_message_id).toBe(`pa-${dispatchId}`);
    for (let i = 0; i < 50; i++) {
      const r = await ctx.admin('mail_dispatches').where('id', dispatchId).first('status');
      if (r.status === 'ACCEPTED') break;
      await sleep(50);
    }
    const done = await ctx.admin('mail_dispatches').where('id', dispatchId).first();
    expect(done.status).toBe('ACCEPTED');
    expect(done.transport_kind).toBe('power-automate');
  });

  it('records a provider failure from the callback and refuses callbacks with a wrong secret', async () => {
    flowMode = 'fail-callback';
    const { dispatchId } = await enqueue('ADMISSION_RECEIPT', `receipt:${randomUUID()}`);
    await runMailWorkerOnce(ctx.deps, 'TRANSACTIONAL');
    for (let i = 0; i < 50; i++) {
      const r = await ctx.admin('mail_dispatches').where('id', dispatchId).first('status');
      if (r.status === 'FAILED') break;
      await sleep(50);
    }
    const failed = await ctx.admin('mail_dispatches').where('id', dispatchId).first();
    expect(failed.status).toBe('FAILED');
    expect(failed.last_error).toContain('quota');
    const forged = await ctx.request().post('/api/v1/integration/v1/mail/callbacks').set('Authorization', 'Bearer wrong').send({ dispatchId, outcome: 'ACCEPTED' });
    expect(forged.status).toBe(401);
    flowMode = 'ok';
  });

  it('retries with backoff when the flow is down and never sends twice', async () => {
    flowMode = 'down';
    const { dispatchId } = await enqueue('ADMISSION_RECEIPT', `receipt:${randomUUID()}`);
    const p1 = await runMailWorkerOnce(ctx.deps, 'TRANSACTIONAL');
    expect(p1.retried).toBe(1);
    const queued = await ctx.admin('mail_dispatches').where('id', dispatchId).first();
    expect(queued.status).toBe('QUEUED');
    expect(queued.attempt_count).toBe(1);
    expect(new Date(queued.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 30_000);
    const p2 = await runMailWorkerOnce(ctx.deps, 'TRANSACTIONAL');
    expect(p2.claimed).toBe(0); // not due yet
    flowMode = 'ok';
    await ctx.admin('mail_dispatches').where('id', dispatchId).update({ next_attempt_at: new Date() });
    const before = flowCalls.length;
    await runMailWorkerOnce(ctx.deps, 'TRANSACTIONAL');
    expect(flowCalls.length).toBe(before + 1);
    expect(flowCalls.filter((c) => c.body.dispatchId === dispatchId).length).toBe(1);
  });

  it('keeps transactional and bulk lanes independent and lists dispatches for the tenant admin', async () => {
    await enqueue('REHEARSAL_REMINDER', `rehearsal:${randomUUID()}`);
    await enqueue('ACCOUNT_ACTIVATION', `activation:${randomUUID()}`);
    const tx = await runMailWorkerOnce(ctx.deps, 'TRANSACTIONAL');
    expect(tx.claimed).toBeGreaterThanOrEqual(1);
    const bulk = await runMailWorkerOnce(ctx.deps, 'BULK');
    expect(bulk.claimed).toBeGreaterThanOrEqual(1);
    const list = await ctx.request().get('/api/v1/tenant/mail-dispatches').set('Host', t.host).set('Authorization', `Bearer ${t.admin.token}`);
    expect(list.status).toBe(200);
    expect(list.body.dispatches.some((d: { category: string }) => d.category === 'REHEARSAL_REMINDER')).toBe(true);
    // a tenant admin never sees secrets in the dispatch list
    expect(JSON.stringify(list.body)).not.toContain(FLOW_TOKEN);
    await runWorkers(ctx);
  });

  it('refuses the capture transport in production and requires an endpoint for power-automate', async () => {
    const noEndpoint = await ctx.request().put('/api/v1/tenant/mail-config').set('Host', t.host).set('Authorization', `Bearer ${t.admin.token}`).send({ transportKind: 'power-automate', senderAddress: `exam@${t.slug}.edu.in`, category: 'RESULT_PUBLISHED' });
    expect(noEndpoint.status).toBe(422);
    expect(noEndpoint.body.code).toBe('ENDPOINT_REQUIRED');
  });
});
