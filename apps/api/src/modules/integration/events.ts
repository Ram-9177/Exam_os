import type { Knex } from '@examos/db';
import type { WebhookEventType } from '@examos/contracts';

export interface RecordEventInput {
  tenantId: string;
  type: WebhookEventType;
  aggregateType: string;
  aggregateId: string | null;
  data: Record<string, unknown>;
}

/**
 * Records a canonical integration event and its outbox row in the caller's
 * transaction (review §5). The dispatcher fans the event out to webhook
 * endpoints; the cursor feed reads integration_events directly.
 */
export async function recordIntegrationEvent(trx: Knex.Transaction, input: RecordEventInput): Promise<string> {
  const [ev] = await trx('integration_events')
    .insert({ tenant_id: input.tenantId, type: input.type, aggregate_type: input.aggregateType, aggregate_id: input.aggregateId, payload: JSON.stringify(input.data) })
    .returning(['id', 'seq']);
  await trx('outbox_events').insert({ tenant_id: input.tenantId, channel: 'WEBHOOK', event_type: input.type, aggregate_type: 'integration_event', aggregate_id: ev.id, payload: JSON.stringify({ integrationEventId: ev.id }) });
  return ev.id as string;
}

export interface FeedPage {
  events: Array<{ id: string; type: string; tenantId: string; occurredAt: string; version: 1; data: Record<string, unknown>; cursor: string }>;
  nextCursor: string | null;
}

/** Cursor feed for ERPs that cannot receive webhooks. Cursor = seq as string. */
export async function readEventFeed(trx: Knex.Transaction, tenantId: string, since: string | undefined, limit: number, types?: string[]): Promise<FeedPage> {
  const sinceSeq = since && /^\d+$/.test(since) ? BigInt(since) : 0n;
  let q = trx('integration_events').where('tenant_id', tenantId).where('seq', '>', sinceSeq.toString()).orderBy('seq').limit(limit + 1);
  if (types && types.length) q = q.whereIn('type', types);
  const rows = await q;
  const page = rows.slice(0, limit);
  return {
    events: page.map((r) => ({ id: r.id, type: r.type, tenantId: r.tenant_id, occurredAt: new Date(r.occurred_at).toISOString(), version: 1 as const, data: r.payload, cursor: String(r.seq) })),
    nextCursor: rows.length > limit ? String(page[page.length - 1]!.seq) : null,
  };
}
