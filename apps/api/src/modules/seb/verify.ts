import type { Request } from 'express';
import { sha256Hex } from '../../lib/crypto.js';

/**
 * What a request carries to show it came from Safe Exam Browser running this exam's configuration.
 *
 * Two routes, because SEB builds differ:
 * - header path (SEB for Windows adds them to every request): `X-SafeExamBrowser-ConfigKeyHash` and
 *   `X-SafeExamBrowser-RequestHash` = SHA-256(absolute request URL + Config Key / Browser Exam Key);
 * - JavaScript API path (SEB for macOS/iOS cannot add headers to fetch): the page reads
 *   `SafeExamBrowser.security.configKey`/`browserExamKey` — hashes computed by SEB for the PAGE URL — and sends them
 *   with that URL as `X-SEB-Page-Url`, `X-SEB-Config-Key-Hash`, `X-SEB-BEK-Hash`.
 *
 * Honesty: the Config Key is derived from the .seb file a student can read, so a matching hash proves the request was
 * made by something that knows the configuration — SEB itself in every normal case. Registering Browser Exam Keys
 * (which also cover the SEB build) raises the bar further. Neither is called proof of a locked-down machine; failures
 * are recorded and refused, successes are recorded as SECURE_CLIENT evidence.
 */
export interface SebEvidence {
  requestUrl: string;
  host: string;
  configKeyHash?: string;
  requestHash?: string;
  pageUrl?: string;
  jsConfigKeyHash?: string;
  jsBekHash?: string;
}

export function sebEvidence(req: Request): SebEvidence {
  const h = (n: string) => req.header(n) ?? undefined;
  return {
    requestUrl: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
    host: req.get('host') ?? '',
    configKeyHash: h('x-safeexambrowser-configkeyhash'),
    requestHash: h('x-safeexambrowser-requesthash'),
    pageUrl: h('x-seb-page-url'),
    jsConfigKeyHash: h('x-seb-config-key-hash'),
    jsBekHash: h('x-seb-bek-hash'),
  };
}

export interface SebPolicy {
  configKey: string;
  browserExamKeys: string[];
}

/** The SEB requirement of an exam, or null when the exam does not require SEB. */
export function sebPolicyOf(exam: { security_profile: string; policy: unknown }): SebPolicy | null {
  const p = (exam.policy ?? {}) as Record<string, unknown>;
  if (exam.security_profile !== 'SECURE_BYOD' || p['requireManagedEndpoint']) return null;
  const configKey = typeof p['sebConfigKey'] === 'string' ? p['sebConfigKey'] : null;
  if (!configKey) return null;
  const beks = Array.isArray(p['sebBrowserExamKeys']) ? (p['sebBrowserExamKeys'] as unknown[]).filter((k): k is string => typeof k === 'string' && /^[a-f0-9]{64}$/i.test(k)) : [];
  return { configKey, browserExamKeys: beks };
}

export type SebOutcome = { ok: true; method: 'header' | 'js-api' } | { ok: false; reason: 'NO_SEB_KEY' | 'CONFIG_KEY_MISMATCH' | 'BROWSER_EXAM_KEY_MISMATCH' | 'PAGE_URL_FOREIGN' };

const same = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

export function verifySeb(policy: SebPolicy, ev: SebEvidence): SebOutcome {
  const bekOk = (url: string, presented: string | undefined) => !policy.browserExamKeys.length || policy.browserExamKeys.some((k) => same(presented, sha256Hex(`${url}${k}`)));
  if (ev.configKeyHash) {
    if (!same(ev.configKeyHash, sha256Hex(`${ev.requestUrl}${policy.configKey}`))) return { ok: false, reason: 'CONFIG_KEY_MISMATCH' };
    if (!bekOk(ev.requestUrl, ev.requestHash)) return { ok: false, reason: 'BROWSER_EXAM_KEY_MISMATCH' };
    return { ok: true, method: 'header' };
  }
  if (ev.jsConfigKeyHash && ev.pageUrl) {
    let pageHost = '';
    try {
      pageHost = new URL(ev.pageUrl).host;
    } catch {
      return { ok: false, reason: 'PAGE_URL_FOREIGN' };
    }
    // The hashed page must be this exam site, not a URL of the client's choosing.
    if (pageHost !== ev.host) return { ok: false, reason: 'PAGE_URL_FOREIGN' };
    if (!same(ev.jsConfigKeyHash, sha256Hex(`${ev.pageUrl}${policy.configKey}`))) return { ok: false, reason: 'CONFIG_KEY_MISMATCH' };
    if (!bekOk(ev.pageUrl, ev.jsBekHash)) return { ok: false, reason: 'BROWSER_EXAM_KEY_MISMATCH' };
    return { ok: true, method: 'js-api' };
  }
  return { ok: false, reason: 'NO_SEB_KEY' };
}
