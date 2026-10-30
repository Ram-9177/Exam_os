import { randomUUID } from 'node:crypto';
import type { MailTransport, MailDispatchRow, ResolvedMailConfig, TransportOutcome } from './index.js';

export class AcsEmailTransport implements MailTransport {
  readonly kind = 'acs-email';
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async send(dispatch: MailDispatchRow, config: ResolvedMailConfig): Promise<TransportOutcome> {
    const endpoint = config.endpoint || (config.settings['endpoint'] as string);
    if (!endpoint) {
      return { outcome: 'FAILED', error: 'acs-email requires an endpoint URL' };
    }
    let url = endpoint;
    if (!url.includes('/emails:send')) {
      url = `${url.replace(/\/+$/, '')}/emails:send`;
    }
    if (!url.includes('api-version=')) {
      url = `${url}${url.includes('?') ? '&' : '?'}api-version=2023-03-31`;
    }

    const body = {
      senderAddress: config.senderAddress,
      content: {
        subject: dispatch.subject,
        plainText: dispatch.body_text,
        html: dispatch.body_html,
      },
      recipients: {
        to: [{ address: dispatch.to_address, displayName: dispatch.to_name ?? undefined }],
      },
    };

    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (config.token) {
        headers['authorization'] = `Bearer ${config.token}`;
      } else if (config.settings['accessKey']) {
        headers['x-ms-access-key'] = String(config.settings['accessKey']);
      }

      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (res.status === 202 || res.status === 200) {
        const opId = res.headers.get('operation-id') || res.headers.get('x-ms-request-id') || `acs-${randomUUID()}`;
        return { outcome: 'ACCEPTED', providerMessageId: opId };
      }

      const text = await res.text();
      if (res.status >= 500 || res.status === 429) {
        return { outcome: 'RETRY', error: `ACS HTTP ${res.status}: ${text.slice(0, 500)}` };
      }
      return { outcome: 'FAILED', error: `ACS HTTP ${res.status}: ${text.slice(0, 500)}` };
    } catch (e) {
      return { outcome: 'RETRY', error: e instanceof Error ? e.message : 'ACS network error' };
    }
  }
}
