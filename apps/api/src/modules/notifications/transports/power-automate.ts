import type { MailDispatchRow, MailTransport, ResolvedMailConfig, TransportOutcome } from './index.js';

/**
 * Power Automate transport (review §6).
 *
 * POSTs the rendered mail to a cloud flow whose trigger is "When an HTTP
 * request is received" and whose action is "Send an email from a shared
 * mailbox (V2)" using the tenant's exam mailbox (e.g. exam@smru.edu.in).
 *
 * Request body schema expected by the flow:
 *   { dispatchId, tenantId, from, fromName, to, toName, subject, html, text, category }
 *
 * Security layers: the flow URL (with its SAS signature) is a vault reference;
 * ExamOS also sends `X-ExamOS-Token`, a per-tenant shared secret the flow
 * checks in its first condition; `X-ExamOS-Timestamp` lets the flow reject
 * stale replays if the team adds that condition. When the tenant validates
 * Entra OAuth on the trigger, `settings.entraBearerToken` can supply a bearer
 * token obtained by the caller.
 *
 * The flow answers 202 immediately; delivery outcome arrives later through
 * POST /integration/v1/mail/callbacks, so the dispatch stays SENDING until then.
 */
export class PowerAutomateTransport implements MailTransport {
  readonly kind = 'power-automate' as const;
  constructor(private readonly fetchImpl: typeof fetch, private readonly timeoutMs = 15_000) {}

  async send(d: MailDispatchRow, cfg: ResolvedMailConfig): Promise<TransportOutcome> {
    if (!cfg.endpoint) return { outcome: 'FAILED', error: 'power-automate transport has no flow endpoint configured' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-examos-dispatch-id': d.id,
        'x-examos-timestamp': new Date().toISOString(),
      };
      if (cfg.token) headers['x-examos-token'] = cfg.token;
      const bearer = cfg.settings['entraBearerToken'];
      if (typeof bearer === 'string' && bearer) headers['authorization'] = `Bearer ${bearer}`;
      const res = await this.fetchImpl(cfg.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          dispatchId: d.id,
          tenantId: d.tenant_id,
          from: cfg.senderAddress,
          fromName: cfg.senderName,
          to: d.to_address,
          toName: d.to_name ?? '',
          subject: d.subject,
          html: d.body_html,
          text: d.body_text,
          category: d.category,
        }),
        signal: controller.signal,
      });
      if (res.status === 200 || res.status === 202) {
        let providerMessageId: string | undefined;
        try {
          const json = (await res.json()) as { messageId?: string };
          if (typeof json?.messageId === 'string') providerMessageId = json.messageId;
        } catch {
          /* flows may answer with an empty body */
        }
        return { outcome: 'PENDING_CALLBACK', providerMessageId };
      }
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        return { outcome: 'FAILED', error: `flow rejected the request with HTTP ${res.status}` };
      }
      return { outcome: 'RETRY', error: `flow answered HTTP ${res.status}` };
    } catch (e) {
      return { outcome: 'RETRY', error: e instanceof Error ? e.message : 'network error' };
    } finally {
      clearTimeout(timer);
    }
  }
}
