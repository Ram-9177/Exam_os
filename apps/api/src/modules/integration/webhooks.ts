import { withWorkerTx, type Knex } from '@examos/db';
import type { WebhookEventType } from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { decryptAtRest, encryptAtRest, randomToken, signWebhook } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';

const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600, 86400];
const DELIVERY_TIMEOUT_MS = 10_000;

export async function createWebhookEndpoint(
  deps: AppDeps,
  trx: Knex.Transaction,
  input: { tenantId: string; url: string; description?: string; eventTypes: WebhookEventType[]; createdBy: string | null; connectionId?: string | null },
): Promise<{ id: string; secret: string }> {
  const secret = `whsec_${randomToken(32)}`;
  const [row] = await trx('webhook_endpoints')
    .insert({ tenant_id: input.tenantId, connection_id: input.connectionId ?? null, url: input.url, description: input.description ?? null, secret_ciphertext: encryptAtRest(deps.config.appEncryptionKey, secret), event_types: input.eventTypes, created_by: input.createdBy })
    .returning('id');
  await audit(trx, { tenantId: input.tenantId, actorType: input.createdBy ? 'USER' : 'API_KEY', actorId: input.createdBy, action: 'webhook.created', entityType: 'webhook_endpoint', entityId: row.id, metadata: { url: input.url, eventTypes: input.eventTypes } });
  return { id: row.id, secret };
}

export async function disableWebhookEndpoint(trx: Knex.Transaction, tenantId: string, id: string, actorId: string | null): Promise<void> {
  const n = await trx('webhook_endpoints').where({ tenant_id: tenantId, id }).update({ status: 'DISABLED', updated_at: trx.fn.now() });
  if (!n) throw AppError.notFound('WEBHOOK_NOT_FOUND');
  await audit(trx, { tenantId, actorType: 'USER', actorId, action: 'webhook.disabled', entityType: 'webhook_endpoint', entityId: id });
}

/**
 * Outbox dispatcher pass: fans each WEBHOOK outbox event out to the tenant's
 * active endpoints subscribed to that type. Idempotent through the
 * (endpoint_id, integration_event_id) unique constraint.
 */
export async function runOutboxDispatcherOnce(deps: AppDeps, batchSize = 100): Promise<{ processed: number; deliveriesCreated: number }> {
  let processed = 0;
  let deliveriesCreated = 0;
  await withWorkerTx(deps.db, async (trx) => {
    const rows = await trx('outbox_events').where('status', 'PENDING').where('next_attempt_at', '<=', trx.fn.now()).orderBy('created_at').limit(batchSize).forUpdate().skipLocked();
    for (const ev of rows) {
      processed++;
      try {
        if (ev.channel === 'WEBHOOK') {
          const endpoints = await trx('webhook_endpoints').where({ tenant_id: ev.tenant_id, status: 'ACTIVE' }).whereRaw('? = ANY(event_types)', [ev.event_type]);
          for (const ep of endpoints) {
            const inserted = await trx('webhook_deliveries')
              .insert({ tenant_id: ev.tenant_id, endpoint_id: ep.id, integration_event_id: ev.aggregate_id, event_type: ev.event_type })
              .onConflict(['endpoint_id', 'integration_event_id'])
              .ignore()
              .returning('id');
            if (inserted.length) deliveriesCreated++;
          }
        }
        await trx('outbox_events').where('id', ev.id).update({ status: 'DONE', processed_at: trx.fn.now(), attempts: ev.attempts + 1 });
      } catch (e) {
        await trx('outbox_events').where('id', ev.id).update({ attempts: ev.attempts + 1, last_error: e instanceof Error ? e.message : String(e), next_attempt_at: new Date(deps.clock.now().getTime() + 60_000), status: ev.attempts + 1 >= 10 ? 'FAILED' : 'PENDING' });
      }
    }
  });
  return { processed, deliveriesCreated };
}

/**
 * Webhook delivery pass. Signs the canonical envelope with the endpoint's
 * secret (review §5) and retries with exponential backoff before dead-lettering.
 */
export async function runWebhookWorkerOnce(deps: AppDeps, batchSize = 50): Promise<{ claimed: number; delivered: number; retried: number; dead: number }> {
  const stats = { claimed: 0, delivered: 0, retried: 0, dead: 0 };
  const claimed = await withWorkerTx(deps.db, async (trx) => {
    const rows = await trx('webhook_deliveries as d')
      .join('webhook_endpoints as e', 'e.id', 'd.endpoint_id')
      .join('integration_events as i', 'i.id', 'd.integration_event_id')
      .whereIn('d.status', ['PENDING', 'RETRYING'])
      .where('d.next_attempt_at', '<=', trx.fn.now())
      .where('e.status', 'ACTIVE')
      .select('d.id', 'd.tenant_id', 'd.attempts', 'e.url', 'e.secret_ciphertext', 'i.id as event_id', 'i.type', 'i.occurred_at', 'i.payload')
      .orderBy('d.created_at')
      .limit(batchSize)
      .forUpdate('d')
      .skipLocked();
    if (rows.length) await trx('webhook_deliveries').whereIn('id', rows.map((r) => r.id)).update({ locked_at: trx.fn.now() });
    return rows;
  });
  stats.claimed = claimed.length;

  for (const d of claimed) {
    const attempt = d.attempts + 1;
    const envelope = { id: d.event_id, type: d.type, tenantId: d.tenant_id, occurredAt: new Date(d.occurred_at).toISOString(), version: 1, data: d.payload };
    const body = JSON.stringify(envelope);
    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      const secret = decryptAtRest(deps.config.appEncryptionKey, d.secret_ciphertext);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
      try {
        const res = await deps.fetch(d.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'ExamOS-Webhooks/1', 'x-examos-signature': signWebhook(secret, body), 'x-examos-event': d.type, 'x-examos-delivery': d.id },
          body,
          signal: controller.signal,
        });
        statusCode = res.status;
        if (!(res.status >= 200 && res.status < 300)) error = `endpoint answered ${res.status}`;
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'network error';
    }
    await withWorkerTx(deps.db, async (trx) => {
      if (!error) {
        stats.delivered++;
        await trx('webhook_deliveries').where('id', d.id).update({ status: 'DELIVERED', attempts: attempt, last_status_code: statusCode, last_error: null, delivered_at: trx.fn.now(), locked_at: null });
      } else if (attempt <= BACKOFF_SECONDS.length) {
        stats.retried++;
        const delay = BACKOFF_SECONDS[attempt - 1]!;
        await trx('webhook_deliveries').where('id', d.id).update({ status: 'RETRYING', attempts: attempt, last_status_code: statusCode, last_error: error, next_attempt_at: new Date(deps.clock.now().getTime() + delay * 1000), locked_at: null });
      } else {
        stats.dead++;
        await trx('webhook_deliveries').where('id', d.id).update({ status: 'DEAD', attempts: attempt, last_status_code: statusCode, last_error: error, locked_at: null });
      }
    });
  }
  return stats;
}

/** Admin replay of a dead delivery (visible in the tenant admin, review §5). */
export async function replayDelivery(trx: Knex.Transaction, tenantId: string, deliveryId: string, actorId: string): Promise<void> {
  const n = await trx('webhook_deliveries').where({ tenant_id: tenantId, id: deliveryId }).whereIn('status', ['DEAD', 'RETRYING']).update({ status: 'PENDING', next_attempt_at: trx.fn.now(), attempts: 0, locked_at: null });
  if (!n) throw AppError.notFound('DELIVERY_NOT_FOUND');
  await audit(trx, { tenantId, actorType: 'USER', actorId, action: 'webhook.delivery.replayed', entityType: 'webhook_delivery', entityId: deliveryId });
}
