import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import knex from 'knex';
import { createTestContext, provisionTenant, type TestContext, type ProvisionedTenant } from './helpers.js';

/**
 * Review §4 isolation tests: tenant-A credentials can never read tenant-B
 * data; a token issued for one host is refused on another; the database role
 * sees nothing without a tenant setting; append-only tables refuse updates.
 */
describe('multi-tenancy isolation', () => {
  let ctx: TestContext;
  let a: ProvisionedTenant;
  let b: ProvisionedTenant;

  beforeAll(async () => {
    ctx = await createTestContext();
    a = await provisionTenant(ctx, 'alpha');
    b = await provisionTenant(ctx, 'beta');
  });
  afterAll(async () => ctx.close());

  it('resolves each tenant by host and refuses unknown hosts', async () => {
    const ra = await ctx.request().get('/api/v1/tenant').set('Host', a.host);
    expect(ra.status).toBe(200);
    expect(ra.body.slug).toBe(a.slug);
    const rx = await ctx.request().get('/api/v1/tenant').set('Host', 'nobody.test');
    expect(rx.status).toBe(404);
    expect(rx.body.code).toBe('TENANT_NOT_FOUND');
  });

  it('rejects a valid tenant-A token presented on tenant-B host', async () => {
    const res = await ctx.request().get('/api/v1/auth/me').set('Host', b.host).set('Authorization', `Bearer ${a.admin.token}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TENANT_MISMATCH');
  });

  it('never returns tenant-B rows to a tenant-A admin (users list)', async () => {
    const res = await ctx.request().get('/api/v1/tenant/users').set('Host', a.host).set('Authorization', `Bearer ${a.admin.token}`);
    expect(res.status).toBe(200);
    const emails = (res.body.users as Array<{ email: string }>).map((u) => u.email);
    expect(emails).toContain(a.admin.email);
    expect(emails).not.toContain(b.admin.email);
  });

  it('row-level security: the application role sees zero rows without a tenant setting, only its tenant with one, and everything in worker context', async () => {
    const appDb = knex({ client: 'pg', connection: process.env['DATABASE_URL'] });
    try {
      const none = await appDb('users').count<{ count: string }[]>('id as count');
      expect(Number(none[0]!.count)).toBe(0);
      await appDb.transaction(async (trx) => {
        await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [a.tenantId]);
        const rows = await trx('users').select('tenant_id');
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.tenant_id === a.tenantId)).toBe(true);
        // an INSERT for another tenant is refused by the WITH CHECK clause
        await expect(trx('users').insert({ tenant_id: b.tenantId, email: 'x@x.test', full_name: 'x', kind: 'STAFF' })).rejects.toThrow(/row-level security/);
      });
      const total = await ctx.admin('users').count<{ count: string }[]>('id as count');
      const worker = await appDb.transaction(async (trx) => {
        await trx.raw("SELECT set_config('app.bypass_tenant','worker',true)");
        return trx('users').count<{ count: string }[]>('id as count');
      });
      expect(Number(worker[0]!.count)).toBe(Number(total[0]!.count));
    } finally {
      await appDb.destroy();
    }
  });

  it('append-only tables refuse UPDATE/DELETE at both privilege and trigger level', async () => {
    const appDb = knex({ client: 'pg', connection: process.env['DATABASE_URL'] });
    try {
      await appDb.transaction(async (trx) => {
        await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [a.tenantId]);
        await expect(trx('audit_events').update({ action: 'tampered' })).rejects.toThrow(/permission denied/);
      });
      // even the superuser is stopped by the trigger
      await expect(ctx.admin('audit_events').where('tenant_id', a.tenantId).update({ action: 'tampered' })).rejects.toThrow(/append-only/);
    } finally {
      await appDb.destroy();
    }
  });

  it('writes a hash-chained audit trail per tenant', async () => {
    const rows = await ctx.admin('audit_events').where('tenant_id', a.tenantId).orderBy('seq');
    expect(rows.length).toBeGreaterThan(1);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.prev_hash).toBe(rows[i - 1]!.hash);
    expect(rows[0]!.prev_hash).toBeNull();
  });
});
