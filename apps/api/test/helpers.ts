import supertest from 'supertest';
import knex, { type Knex } from 'knex';
import express from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../src/app.js';
import { buildDeps, closeDeps } from '../src/deps.js';
import { loadConfig } from '../src/config.js';
import { CaptureTransport } from '../src/modules/notifications/transports/capture.js';
import type { AppDeps } from '../src/types.js';
import { runMailWorkerOnce } from '../src/modules/notifications/worker.js';
import { runOutboxDispatcherOnce, runWebhookWorkerOnce } from '../src/modules/integration/webhooks.js';
import { canonicalJson, sha256Hex } from '../src/lib/crypto.js';

export interface TestContext {
  deps: AppDeps;
  app: App;
  request: () => supertest.Agent;
  admin: Knex; // superuser connection for assertions only
  capture: CaptureTransport;
  close: () => Promise<void>;
}

/**
 * Builds the real application against the test database and Redis. Outbound
 * HTTP (webhooks, Power Automate) is routed through a controllable fetch so
 * tests can point it at local fake servers.
 */
export async function createTestContext(fetchImpl?: typeof fetch): Promise<TestContext> {
  const config = loadConfig();
  const capture = new CaptureTransport();
  const deps = buildDeps({ config, fetchImpl: fetchImpl ?? fetch, capture });
  const app = await createApp(deps);
  const admin = knex({ client: 'pg', connection: config.DATABASE_ADMIN_URL, pool: { min: 0, max: 4 } });
  return {
    deps,
    app,
    request: () => supertest.agent(app.app),
    admin,
    capture,
    close: async () => {
      await admin.destroy();
      await closeDeps(deps);
    },
  };
}

export const PLATFORM_KEY = 'test-platform-bootstrap-key-0123456789';

export interface ProvisionedTenant {
  tenantId: string;
  host: string;
  slug: string;
  admin: { userId: string; email: string; password: string; token: string; refreshToken: string };
}

/** Provisions a tenant through the real platform route and activates its admin through the activation mail. */
export async function provisionTenant(ctx: TestContext, slugPrefix = 't'): Promise<ProvisionedTenant> {
  const slug = `${slugPrefix}-${randomUUID().slice(0, 8)}`;
  const host = `${slug}.test`;
  const adminEmail = `admin@${slug}.test`;
  const res = await ctx.request().post('/api/v1/platform/tenants').set('x-platform-key', PLATFORM_KEY).send({ slug, name: `Tenant ${slug}`, domains: [host], adminEmail, adminFullName: 'Tenant Admin' });
  if (res.status !== 201) throw new Error(`provision failed: ${res.status} ${JSON.stringify(res.body)}`);
  const tenantId = res.body.tenantId as string;
  // mail config: capture transport so worker runs end to end
  const password = 'Str0ng-Passw0rd!2026';
  const token = await activationTokenFor(ctx, tenantId, adminEmail);
  const act = await ctx.request().post('/api/v1/auth/activate').set('Host', host).send({ token, password });
  if (act.status !== 200) throw new Error(`activate failed: ${act.status} ${JSON.stringify(act.body)}`);
  const t: ProvisionedTenant = { tenantId, host, slug, admin: { userId: act.body.user.id, email: adminEmail, password, token: act.body.accessToken, refreshToken: act.body.refreshToken } };
  const mc = await ctx.request().put('/api/v1/tenant/mail-config').set('Host', host).set('Authorization', `Bearer ${t.admin.token}`).send({ transportKind: 'capture', senderAddress: `exam@${slug}.test`, senderName: 'Examination Cell', callbackSecret: `cb-${slug}` });
  if (mc.status !== 204) throw new Error(`mail config failed: ${mc.status} ${JSON.stringify(mc.body)}`);
  return t;
}

/** Reads the activation link out of the queued activation mail (what the student would receive). */
export async function activationTokenFor(ctx: TestContext, tenantId: string, email: string): Promise<string> {
  const row = await ctx.admin('mail_dispatches').where({ tenant_id: tenantId, category: 'ACCOUNT_ACTIVATION', to_address: email.toLowerCase() }).orderBy('created_at', 'desc').first('body_text');
  if (!row) throw new Error(`no activation mail for ${email}`);
  const m = /token=([^\s]+)/.exec(row.body_text as string);
  if (!m) throw new Error('activation mail has no token');
  return decodeURIComponent(m[1]!);
}

export async function login(ctx: TestContext, host: string, email: string, password: string) {
  const res = await ctx.request().post('/api/v1/auth/login').set('Host', host).send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { accessToken: string; refreshToken: string; user: { id: string } };
}

/** Creates a staff user with roles via the tenant admin API and activates it. */
export async function createStaff(ctx: TestContext, t: ProvisionedTenant, roles: string[], label: string) {
  const email = `${label}-${randomUUID().slice(0, 6)}@${t.slug}.test`;
  const res = await ctx.request().post('/api/v1/tenant/users').set('Host', t.host).set('Authorization', `Bearer ${t.admin.token}`).send({ email, fullName: label, kind: 'STAFF', roles: roles.map((role) => ({ role })) });
  if (res.status !== 201) throw new Error(`createStaff failed: ${res.status} ${JSON.stringify(res.body)}`);
  const token = await activationTokenFor(ctx, t.tenantId, email);
  const password = 'Staff-Passw0rd!2026';
  const act = await ctx.request().post('/api/v1/auth/activate').set('Host', t.host).send({ token, password });
  if (act.status !== 200) throw new Error(`activate staff failed: ${act.status}`);
  return { userId: res.body.userId as string, email, password, token: act.body.accessToken as string };
}

/** The first admin login holds the ADMIN_CONTROLLER bundle (TENANT_ADMIN + CONTROLLER + SECURITY_AUDITOR). */
export function adminAsController(t: ProvisionedTenant) {
  return { userId: t.admin.userId, email: t.admin.email, password: t.admin.password, token: t.admin.token };
}

/** Super admin (bootstrap key in tests) sets a staff login's duties; tenant admins cannot change their own. */
export async function setStaffRoles(ctx: TestContext, t: ProvisionedTenant, userId: string, roles: string[]) {
  const res = await ctx.request().put(`/api/v1/platform/tenants/${t.tenantId}/staff/${userId}/roles`).set('x-platform-key', PLATFORM_KEY).send({ roles });
  if (res.status !== 204) throw new Error(`setStaffRoles failed: ${res.status} ${JSON.stringify(res.body)}`);
}

export async function createApiKey(ctx: TestContext, t: ProvisionedTenant, scopes: string[]) {
  const res = await ctx.request().post('/api/v1/tenant/api-keys').set('Host', t.host).set('Authorization', `Bearer ${t.admin.token}`).send({ label: 'erp', scopes });
  if (res.status !== 201) throw new Error(`api key failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; keyId: string; apiKey: string };
}

export async function runWorkers(ctx: TestContext) {
  const outbox = await runOutboxDispatcherOnce(ctx.deps);
  const webhooks = await runWebhookWorkerOnce(ctx.deps);
  const tx = await runMailWorkerOnce(ctx.deps, 'TRANSACTIONAL');
  const bulk = await runMailWorkerOnce(ctx.deps, 'BULK');
  return { outbox, webhooks, tx, bulk };
}

/** Starts a throwaway HTTP server (fake ERP webhook receiver, fake Power Automate flow, fake IdP). */
export async function startFakeServer(configure: (app: express.Express) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));
  configure(app);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(() => r())) };
}

export function answerHash(blocks: Array<{ id: string; kind: string; content: unknown }>): string {
  return sha256Hex(canonicalJson({ blocks }));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A realistic single-screen laptop scan with nothing to report. */
export function cleanScan(overrides: Record<string, unknown> = {}) {
  return {
    takenAt: new Date().toISOString(),
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0',
    platform: 'Win32',
    language: 'en-IN',
    timezone: 'Asia/Kolkata',
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelRatio: 1, isExtended: false, displayCount: 1 },
    window: { innerWidth: 1920, innerHeight: 960, outerWidth: 1920, outerHeight: 1040 },
    hardware: { cores: 8, memoryGb: 8, touchPoints: 0, pointerFine: true },
    gpu: { vendor: 'Intel', renderer: 'Intel(R) UHD Graphics 620' },
    browser: { webdriver: false, cookiesEnabled: true, fullscreenSupported: true, pdfViewer: true, pluginsCount: 5, displayCaptureActive: false, devtoolsHeuristic: false },
    network: { effectiveType: '4g', downlinkMbps: 10, rttMs: 50, online: true },
    battery: { level: 0.9, charging: true },
    visibility: 'visible',
    ...overrides,
  };
}
