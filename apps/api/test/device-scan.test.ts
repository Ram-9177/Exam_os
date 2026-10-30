import { describe, it, expect } from 'vitest';
import { deriveScanFindings, sameUtcOffset, scanVerdict, utcOffsetMinutes } from '../src/modules/attempts/device-scan.js';
import { cleanScan } from './helpers.js';
import type { DeviceScan } from '@examos/contracts';

const scan = (overrides: Record<string, unknown> = {}) => cleanScan(overrides) as unknown as DeviceScan;
const jan = new Date('2026-01-15T12:00:00Z');
const jul = new Date('2026-07-15T12:00:00Z');

/**
 * The server derives every finding from the raw scan. These cases come from
 * running the real client: Chrome on many Indian machines reports the zone as
 * "Asia/Calcutta" while tenants are configured as "Asia/Kolkata" — a name
 * comparison flagged every such student.
 */
describe('device scan findings', () => {
  it('compares time zones by UTC offset, so aliases match and real differences do not', () => {
    expect(utcOffsetMinutes('Asia/Kolkata', jan)).toBe(330);
    expect(utcOffsetMinutes('Asia/Calcutta', jan)).toBe(330);
    expect(utcOffsetMinutes('Asia/Kathmandu', jan)).toBe(345);
    expect(utcOffsetMinutes('America/New_York', jan)).toBe(-300);
    expect(utcOffsetMinutes('America/New_York', jul)).toBe(-240);
    expect(utcOffsetMinutes('Not/AZone', jan)).toBeNull();
    expect(sameUtcOffset('Asia/Calcutta', 'Asia/Kolkata', jan)).toBe(true);
    expect(sameUtcOffset('Europe/Kiev', 'Europe/Kyiv', jul)).toBe(true);
    expect(sameUtcOffset('Asia/Kathmandu', 'Asia/Kolkata', jan)).toBe(false);
    expect(sameUtcOffset('Not/AZone', 'Asia/Kolkata', jan)).toBe(false);

    expect(deriveScanFindings(scan({ timezone: 'Asia/Calcutta' }), 'Asia/Kolkata')).toEqual([]);
    expect(deriveScanFindings(scan({ timezone: 'Asia/Kolkata' }), 'Asia/Kolkata')).toEqual([]);
    expect(deriveScanFindings(scan({ timezone: 'Europe/London' }), 'Asia/Kolkata')).toEqual(['TIMEZONE_MISMATCH']);
    expect(deriveScanFindings(scan({ timezone: 'Not/AZone' }), 'Asia/Kolkata')).toEqual(['TIMEZONE_MISMATCH']);
    expect(scanVerdict(['TIMEZONE_MISMATCH'])).toBe('REVIEW');
  });

  it('flags what a headless, automated or virtualised browser reports, and nothing on a clean laptop', () => {
    expect(deriveScanFindings(scan(), 'Asia/Kolkata')).toEqual([]);
    const browser = { webdriver: true, cookiesEnabled: true, fullscreenSupported: true, pdfViewer: true, pluginsCount: 5, displayCaptureActive: false, devtoolsHeuristic: false };
    expect(deriveScanFindings(scan({ browser }), 'Asia/Kolkata')).toEqual(['AUTOMATION_CONTROLLED']);
    expect(scanVerdict(['AUTOMATION_CONTROLLED'])).toBe('BLOCKED');
    const screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelRatio: 1, isExtended: true, displayCount: null };
    expect(deriveScanFindings(scan({ screen }), 'Asia/Kolkata')).toEqual(['MULTIPLE_DISPLAYS']);
    // software rendering (headless Chromium, Linux laptops without a GPU driver) is not a virtual machine
    expect(deriveScanFindings(scan({ gpu: { vendor: 'Google Inc. (Google)', renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)' } }), 'Asia/Kolkata')).toEqual([]);
    expect(deriveScanFindings(scan({ gpu: { vendor: 'VMware, Inc.', renderer: 'SVGA3D; build: RELEASE' } }), 'Asia/Kolkata')).toEqual(['VIRTUAL_MACHINE_SUSPECTED']);
    expect(deriveScanFindings(scan({ battery: { level: 0.2, charging: false } }), 'Asia/Kolkata')).toEqual(['LOW_BATTERY_UNPLUGGED']);
  });
});
