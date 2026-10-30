import type { Knex } from '@examos/db';
import type { MailHealthMetrics } from '@examos/contracts';

const DAILY_EXTERNAL_BULK_LIMIT = 2000;

export async function getMailHealthMetrics(trx: Knex.Transaction, tenantId: string): Promise<MailHealthMetrics> {
  const statusCounts = (await trx('mail_dispatches')
    .where('tenant_id', tenantId)
    .groupBy('status')
    .select('status', trx.raw('count(*)::int as count'))) as Array<{ status: string; count: number }>;

  const byStatus: Record<string, number> = {};
  for (const s of statusCounts) {
    byStatus[s.status] = s.count;
  }

  const transportCounts = (await trx('mail_dispatches')
    .where('tenant_id', tenantId)
    .whereNotNull('transport_kind')
    .groupBy('transport_kind')
    .select('transport_kind as transportKind', trx.raw('count(*)::int as count'))) as Array<{ transportKind: string; count: number }>;

  const byTransport: Record<string, number> = {};
  for (const t of transportCounts) {
    byTransport[t.transportKind] = t.count;
  }

  const laneCounts = (await trx('mail_dispatches')
    .where('tenant_id', tenantId)
    .groupBy('lane')
    .select('lane', trx.raw('count(*)::int as count'))) as Array<{ lane: string; count: number }>;

  const byLane: Record<string, number> = {};
  for (const l of laneCounts) {
    byLane[l.lane] = l.count;
  }

  // Today's dispatches for external recipients quota tracking
  const [todayRow] = (await trx('mail_dispatches')
    .where('tenant_id', tenantId)
    .andWhere('lane', 'BULK')
    .andWhere('created_at', '>=', trx.raw("date_trunc('day', now())"))
    .select(trx.raw('count(*)::int as count'))) as Array<{ count: number }>;

  const sentToday = todayRow?.count ?? 0;
  const accepted = byStatus['ACCEPTED'] ?? 0;
  const delivered = byStatus['DELIVERED'] ?? 0;
  const bounced = byStatus['BOUNCED'] ?? 0;
  const failed = byStatus['FAILED'] ?? 0;
  const queued = byStatus['QUEUED'] ?? 0;
  const sending = byStatus['SENDING'] ?? 0;
  const total = accepted + delivered + bounced + failed + queued + sending;

  const denominator = accepted + delivered + bounced;
  const bounceRatePct = denominator > 0 ? Number(((bounced / denominator) * 100).toFixed(2)) : 0;

  return {
    totalDispatches: total,
    accepted,
    delivered,
    bounced,
    failed,
    queued,
    sending,
    bounceRatePct,
    byTransport,
    byLane,
    dailyExternalQuota: {
      sentToday,
      limit: DAILY_EXTERNAL_BULK_LIMIT,
      remaining: Math.max(0, DAILY_EXTERNAL_BULK_LIMIT - sentToday),
    },
  };
}

