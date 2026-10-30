import type { MailDispatchRow, MailTransport, ResolvedMailConfig, TransportOutcome } from './index.js';

/**
 * Microsoft Graph transport: POST /users/{exam mailbox}/sendMail with an
 * application token (client credentials). The application permission
 * Mail.Send must be restricted to the exam mailbox with an Exchange
 * application access policy, otherwise the app could send as any mailbox in
 * the tenant (review §6). The caller supplies `settings.tenantId`,
 * `settings.clientId` and the client secret via the token reference.
 */
export class GraphTransport implements MailTransport {
  readonly kind = 'graph' as const;
  private tokenCache = new Map<string, { token: string; expiresAt: number }>();
  constructor(private readonly fetchImpl: typeof fetch) {}

  private async accessToken(cfg: ResolvedMailConfig): Promise<string> {
    const tenantId = String(cfg.settings['tenantId'] ?? '');
    const clientId = String(cfg.settings['clientId'] ?? '');
    if (!tenantId || !clientId || !cfg.token) throw new Error('graph transport requires settings.tenantId, settings.clientId and a client secret reference');
    const key = `${tenantId}:${clientId}`;
    const cached = this.tokenCache.get(key);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const res = await this.fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: cfg.token, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
    });
    if (!res.ok) throw new Error(`token endpoint answered ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.tokenCache.set(key, { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 });
    return json.access_token;
  }

  async send(d: MailDispatchRow, cfg: ResolvedMailConfig): Promise<TransportOutcome> {
    try {
      const token = await this.accessToken(cfg);
      const res = await this.fetchImpl(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.senderAddress)}/sendMail`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            subject: d.subject,
            body: { contentType: 'HTML', content: d.body_html },
            toRecipients: [{ emailAddress: { address: d.to_address, name: d.to_name ?? undefined } }],
            internetMessageHeaders: [{ name: 'X-ExamOS-Dispatch', value: d.id }],
          },
          saveToSentItems: true,
        }),
      });
      if (res.status === 202) return { outcome: 'ACCEPTED' };
      if (res.status === 429 || res.status >= 500) return { outcome: 'RETRY', error: `graph answered ${res.status}` };
      return { outcome: 'FAILED', error: `graph answered ${res.status}` };
    } catch (e) {
      return { outcome: 'RETRY', error: e instanceof Error ? e.message : 'graph error' };
    }
  }
}
