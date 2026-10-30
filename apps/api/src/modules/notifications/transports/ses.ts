import { randomUUID } from 'node:crypto';
import type { MailTransport, MailDispatchRow, ResolvedMailConfig, TransportOutcome } from './index.js';

export class SesTransport implements MailTransport {
  readonly kind = 'ses';
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async send(dispatch: MailDispatchRow, config: ResolvedMailConfig): Promise<TransportOutcome> {
    const endpoint = config.endpoint || (config.settings['endpoint'] as string);
    const region = (config.settings['region'] as string) || 'us-east-1';
    const url = endpoint || `https://email.${region}.amazonaws.com/v2/email/outbound-emails`;

    const body = {
      FromEmailAddress: config.senderName ? `"${config.senderName}" <${config.senderAddress}>` : config.senderAddress,
      Destination: {
        ToAddresses: [dispatch.to_address],
      },
      Content: {
        Simple: {
          Subject: { Data: dispatch.subject },
          Body: {
            Html: { Data: dispatch.body_html },
            Text: { Data: dispatch.body_text },
          },
        },
      },
    };

    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (config.token) {
        headers['authorization'] = `Bearer ${config.token}`;
      } else if (config.settings['apiKey']) {
        headers['x-api-key'] = String(config.settings['apiKey']);
      }

      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (res.status === 200 || res.status === 202) {
        let msgId: string | undefined;
        try {
          const json = (await res.json()) as { MessageId?: string };
          msgId = json.MessageId;
        } catch {
          msgId = res.headers.get('x-amzn-requestid') || `ses-${randomUUID()}`;
        }
        return { outcome: 'ACCEPTED', providerMessageId: msgId ?? `ses-${randomUUID()}` };
      }

      const text = await res.text();
      if (res.status >= 500 || res.status === 429) {
        return { outcome: 'RETRY', error: `SES HTTP ${res.status}: ${text.slice(0, 500)}` };
      }
      return { outcome: 'FAILED', error: `SES HTTP ${res.status}: ${text.slice(0, 500)}` };
    } catch (e) {
      return { outcome: 'RETRY', error: e instanceof Error ? e.message : 'SES network error' };
    }
  }
}

