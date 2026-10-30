import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@examos/db';
import { createTestContext, provisionTenant, type TestContext, type ProvisionedTenant } from './helpers.js';
import { enqueueMail } from '../src/modules/notifications/service.js';
import { runMailWorkerOnce } from '../src/modules/notifications/worker.js';

/**
 * The smtp-relay transport (Nodemailer, IP-authenticated connector relay)
 * against a real SMTP conversation. The responder below is a minimal SMTP
 * server written on node `net`: greeting, EHLO/HELO, MAIL FROM, RCPT TO, DATA,
 * the terminating dot and QUIT. Everything on the ExamOS side (tenant mail
 * config, outbox row, worker claim, Nodemailer client, status/backoff rules)
 * is the production code.
 */
interface Received {
  mailFrom: string;
  rcptTo: string[];
  data: string;
}
type Mode = 'ok' | 'reject-recipient-550' | 'busy-451';

function startSmtpResponder() {
  const received: Received[] = [];
  const state = { mode: 'ok' as Mode };
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    let inData = false;
    let current: Received = { mailFrom: '', rcptTo: [], data: '' };
    const reply = (line: string) => sock.write(`${line}\r\n`);
    reply('220 smtp.responder.test ESMTP ready');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end === -1) return;
          current.data += buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          received.push(current);
          current = { mailFrom: '', rcptTo: [], data: '' };
          reply('250 2.0.0 Ok: queued as RESP1');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') {
          reply('250-smtp.responder.test greets you');
          reply('250 SIZE 10485760');
        } else if (verb === 'HELO') reply('250 smtp.responder.test');
        else if (verb === 'MAIL') {
          if (state.mode === 'busy-451') reply('451 4.3.0 Try again later');
          else {
            current = { mailFrom: line.replace(/^MAIL FROM:\s*/i, ''), rcptTo: [], data: '' };
            reply('250 2.1.0 Ok');
          }
        } else if (verb === 'RCPT') {
          if (state.mode === 'reject-recipient-550') reply('550 5.1.1 Recipient address rejected: user unknown');
          else {
            current.rcptTo.push(line.replace(/^RCPT TO:\s*/i, ''));
            reply('250 2.1.5 Ok');
          }
        } else if (verb === 'DATA') {
          inData = true;
          reply('354 End data with <CR><LF>.<CR><LF>');
        } else if (verb === 'RSET') {
          current = { mailFrom: '', rcptTo: [], data: '' };
          reply('250 2.0.0 Ok');
        } else if (verb === 'NOOP') reply('250 2.0.0 Ok');
        else if (verb === 'QUIT') {
          reply('221 2.0.0 Bye');
          sock.end();
          return;
        } else reply('502 5.5.2 Command not recognized');
      }
    });
    sock.on('error', () => undefined);
  });
  return new Promise<{ port: number; received: Received[]; state: { mode: Mode }; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as net.AddressInfo).port, received, state, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** Decodes RFC 2047 encoded-words (Nodemailer encodes non-ASCII subjects). */
function decodeHeader(v: string): string {
  return v.replace(/\r\n[ \t]+/g, ' ').replace(/=\?utf-8\?([QB])\?([^?]*)\?=\s*/gi, (_m, enc: string, text: string) =>
    enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64').toString('utf8') : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'),
  );
}
function header(data: string, name: string): string | undefined {
  const head = data.split('\r\n\r\n')[0]!;
  const m = new RegExp(`^${name}:\\s*((?:.*)(?:\\r\\n[ \\t].*)*)`, 'im').exec(head);
  return m ? decodeHeader(m[1]!) : undefined;
}

describe('exam mail via SMTP relay (Nodemailer against a live SMTP responder)', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;
  let smtp: Awaited<ReturnType<typeof startSmtpResponder>>;
  const sender = () => `exam@${t.slug}.edu.in`;

  beforeAll(async () => {
    ctx = await createTestContext();
    t = await provisionTenant(ctx, 'smtp');
    smtp = await startSmtpResponder();
    const cfg = await ctx
      .request()
      .put('/api/v1/tenant/mail-config')
      .set('Host', t.host)
      .set('Authorization', `Bearer ${t.admin.token}`)
      .send({ transportKind: 'smtp-relay', senderAddress: sender(), senderName: 'Examination Cell', settings: { host: '127.0.0.1', port: smtp.port, requireTls: false } });
    expect(cfg.status).toBe(204);
  });
  afterAll(async () => {
    await smtp.close();
    await ctx.close();
  });

  async function enqueue(to: string) {
    return withTenantTx(ctx.deps.db, t.tenantId, (trx) =>
      enqueueMail(trx, { tenantId: t.tenantId, category: 'ADMISSION_RECEIPT', to: { address: to, name: 'Student' }, dedupeKey: `receipt:${randomUUID()}`, vars: { fullName: 'Student', examTitle: 'OS Mid-1', portalUrl: 'https://exam.test', precheckOpensLocal: '09:30', tenantName: 'T', activationUrl: 'x', expiresInHours: 48, rehearsalDeadline: 'tomorrow', examStartLocal: 'Mon 10:00', admittedAtLocal: 'now', receiptId: 'r1' } }),
    );
  }
  const forDispatch = (id: string) => smtp.received.filter((m) => header(m.data, 'X-ExamOS-Dispatch') === id);

  it('delivers the outbox row over SMTP with the right envelope, recipient and subject, and marks it sent', async () => {
    smtp.state.mode = 'ok';
    const to = `student-${randomUUID().slice(0, 6)}@${t.slug}.test`;
    const { dispatchId } = await enqueue(to);
    const row = await ctx.admin('mail_dispatches').where('id', dispatchId).first();
    const pass = await runMailWorkerOnce(ctx.deps, 'TRANSACTIONAL');
    expect(pass.accepted).toBeGreaterThanOrEqual(1);

    const msgs = forDispatch(dispatchId!);
    expect(msgs).toHaveLength(1);
    const m = msgs[0]!;
    expect(m.mailFrom).toContain(`<${sender()}>`);
    expect(m.rcptTo).toEqual([`<${to}>`]);
    expect(header(m.data, 'To')).toContain(to);
    expect(header(m.data, 'From')).toContain(sender());
    expect(header(m.data, 'Subject')).toBe(row.subject);
    expect(row.subject).toContain('OS Mid-1');

    const done = await ctx.admin('mail_dispatches').where('id', dispatchId).first();
    expect(done.status).toBe('ACCEPTED');
    expect(done.transport_kind).toBe('smtp-relay');
    expect(done.sent_at).toBeTruthy();
    expect(done.accepted_at).toBeTruthy();
    expect(done.last_error).toBeNull();
    expect(done.provider_message_id).toMatch(/^<.+>$/);
    expect(done.attempt_count).toBe(1);

    // a second pass never sends it again
    await runMailWorkerOnce(ctx.deps, 'TRANSACTIONAL');
    expect(forDispatch(dispatchId!)).toHaveLength(1);
  });

  it('a transient 451 is retried with backoff and delivered once the relay recovers', async () => {
    smtp.state.mode = 'busy-451';
    const to = `student-${randomUUID().slice(0, 6)}@${t.slug}.test`;
    const { dispatchId } = await enqueue(to);
    const p1 = await runMailWorkerOnce(ctx.deps, 'TRANSACTIONAL');
    expect(p1.retried).toBeGreaterThanOrEqual(1);
    const queued = await ctx.admin('mail_dispatches').where('id', dispatchId).first();
    expect(queued.status).toBe('QUEUED');
    expect(queued.attempt_count).toBe(1);
    expect(queued.last_error).toContain('451');
    expect(queued.locked_at).toBeNull();
    // first backoff step is 60 s
    expect(new Date(queued.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect(forDispatch(dispatchId!)).toHaveLength(0);

    // not due yet: the next pass leaves it alone
    expect((await runMailWorkerOnce(ctx.deps, 'TRANSACTIONAL')).claimed).toBe(0);

    smtp.state.mode = 'ok';
    await ctx.admin('mail_dispatches').where('id', dispatchId).update({ next_attempt_at: new Date() });
    await runMailWorkerOnce(ctx.deps, 'TRANSACTIONAL');
    const done = await ctx.admin('mail_dispatches').where('id', dispatchId).first();
    expect(done.status).toBe('ACCEPTED');
    expect(done.attempt_count).toBe(2);
    expect(done.last_error).toBeNull();
    expect(forDispatch(dispatchId!)).toHaveLength(1);
    expect(forDispatch(dispatchId!)[0]!.rcptTo).toEqual([`<${to}>`]);
  });

  it('a permanent 550 rejection fails the row without retrying', async () => {
    smtp.state.mode = 'reject-recipient-550';
    const { dispatchId } = await enqueue(`nobody-${randomUUID().slice(0, 6)}@${t.slug}.test`);
    const p1 = await runMailWorkerOnce(ctx.deps, 'TRANSACTIONAL');
    expect(p1.failed).toBeGreaterThanOrEqual(1);
    const failed = await ctx.admin('mail_dispatches').where('id', dispatchId).first();
    expect(failed.status).toBe('FAILED');
    expect(failed.last_error).toMatch(/^550 /);
    expect(failed.attempt_count).toBe(1);
    expect(failed.accepted_at).toBeNull();
    expect(forDispatch(dispatchId!)).toHaveLength(0);

    smtp.state.mode = 'ok';
    await ctx.admin('mail_dispatches').where('id', dispatchId).update({ next_attempt_at: new Date() });
    await runMailWorkerOnce(ctx.deps, 'TRANSACTIONAL');
    expect((await ctx.admin('mail_dispatches').where('id', dispatchId).first('status')).status).toBe('FAILED');
    expect(forDispatch(dispatchId!)).toHaveLength(0);
  });
});
