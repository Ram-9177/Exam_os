import type { Knex } from '@examos/db';
import { DEVICE_SCAN_FINDINGS, type DeviceScanFinding } from '@examos/contracts';
import type { DeviceScan } from '@examos/contracts';
import { canonicalJson, sha256Hex } from '../../lib/crypto.js';

export type ScanVerdict = 'CLEAN' | 'REVIEW' | 'BLOCKED';

/** GPU renderer strings that only appear inside hypervisors. Software renderers (llvmpipe, SwiftShader) are not listed: real Linux laptops use them. */
const VM_RENDERER = /vmware|virtualbox|parallels|hyper-v|qemu|virgl|vbox/i;
const REMOTE_RENDERER = /microsoft basic render|remotefx|rdp|citrix|teamviewer|anydesk/i;

/**
 * Derives findings from the raw scan. The client never sends a verdict; every
 * finding is recomputed here so a tampered client can at most hide data, which
 * is why a clean scan is recorded as CLIENT_DECLARED context and never as proof.
 */
export function deriveScanFindings(scan: DeviceScan, tenantTimezone: string | null): DeviceScanFinding[] {
  const out = new Set<DeviceScanFinding>();
  const s = scan.screen;
  if (s.isExtended === true || (s.displayCount ?? 0) > 1) out.add('MULTIPLE_DISPLAYS');
  if (s.isExtended === null && s.displayCount === null) out.add('DISPLAY_INFO_UNAVAILABLE');
  if (scan.browser.webdriver) out.add('AUTOMATION_CONTROLLED');
  const renderer = `${scan.gpu.vendor ?? ''} ${scan.gpu.renderer ?? ''}`;
  if (VM_RENDERER.test(renderer)) out.add('VIRTUAL_MACHINE_SUSPECTED');
  if (REMOTE_RENDERER.test(renderer) || (s.colorDepth > 0 && s.colorDepth < 24)) out.add('REMOTE_DESKTOP_SUSPECTED');
  if (scan.browser.displayCaptureActive) out.add('SCREEN_SHARING_ACTIVE');
  if (!scan.browser.fullscreenSupported) out.add('FULLSCREEN_UNSUPPORTED');
  if (!scan.browser.cookiesEnabled) out.add('COOKIES_DISABLED');
  if (scan.browser.devtoolsHeuristic) out.add('DEVTOOLS_SUSPECTED');
  const w = scan.window;
  if (s.availWidth > 0 && s.availHeight > 0 && (w.outerWidth < s.availWidth * 0.9 || w.outerHeight < s.availHeight * 0.85)) out.add('WINDOW_NOT_MAXIMISED');
  if (w.innerWidth < 800 || w.innerHeight < 500) out.add('SMALL_VIEWPORT');
  if (tenantTimezone && scan.timezone && !sameUtcOffset(scan.timezone, tenantTimezone, new Date())) out.add('TIMEZONE_MISMATCH');
  if (scan.battery && !scan.battery.charging && scan.battery.level < 0.3) out.add('LOW_BATTERY_UNPLUGGED');
  return [...out];
}

/**
 * Minutes east of UTC for an IANA zone at an instant, or null for a name the runtime does not know.
 * Zones are compared by offset, not by name: browsers report aliases (Chrome on many Indian machines
 * says "Asia/Calcutta" while the tenant is configured as "Asia/Kolkata"), and a name check would flag
 * every one of those students.
 */
export function utcOffsetMinutes(timeZone: string, at: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(at);
    const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
    const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    if (!Number.isFinite(wall)) return null;
    return Math.round((wall - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
  } catch {
    return null;
  }
}

/** True when both zones are known and keep the same UTC offset at `at`; an unknown zone name is never "the same". */
export function sameUtcOffset(a: string, b: string, at: Date): boolean {
  if (a === b) return true;
  const x = utcOffsetMinutes(a, at);
  const y = utcOffsetMinutes(b, at);
  return x !== null && y !== null && x === y;
}

export function scanVerdict(findings: DeviceScanFinding[]): ScanVerdict {
  if (findings.some((f) => DEVICE_SCAN_FINDINGS[f] === 'BLOCKING')) return 'BLOCKED';
  return findings.length ? 'REVIEW' : 'CLEAN';
}

/** Appends one device_scans row (append-only evidence) and returns the server-derived outcome. */
export async function recordDeviceScan(
  trx: Knex.Transaction,
  args: { tenantId: string; attemptId: string; precheckRunId: string | null; phase: 'PRECHECK' | 'IN_EXAM'; scan: DeviceScan; ip: string | null; userAgent: string | null },
): Promise<{ scanId: string; findings: DeviceScanFinding[]; verdict: ScanVerdict }> {
  const tenant = await trx('tenants').where('id', args.tenantId).first('timezone');
  const findings = deriveScanFindings(args.scan, tenant?.timezone ?? null);
  const verdict = scanVerdict(findings);
  const [row] = await trx('device_scans')
    .insert({
      tenant_id: args.tenantId,
      attempt_id: args.attemptId,
      precheck_run_id: args.precheckRunId,
      phase: args.phase,
      verdict,
      findings: JSON.stringify(findings),
      scan: JSON.stringify(args.scan),
      scan_sha256: sha256Hex(canonicalJson(args.scan)),
      ip: args.ip,
      user_agent: args.userAgent,
    })
    .returning('id');
  return { scanId: row.id as string, findings, verdict };
}
