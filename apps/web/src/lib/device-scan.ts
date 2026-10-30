import type { DeviceScan } from '@examos/contracts';

/**
 * Collects the raw system-settings scan the server turns into findings
 * (displays, automation, virtualisation hints, browser capabilities). Nothing
 * here is a verdict: the client only reports what the browser exposes, and
 * the server decides. Permission prompts are never triggered by the scan; a
 * capability the browser hides is reported as null, which the server lists
 * as "display information unavailable" for a human to see.
 */
type NavigatorExtras = Navigator & {
  deviceMemory?: number;
  pdfViewerEnabled?: boolean;
  connection?: { effectiveType?: string; downlink?: number; rtt?: number };
  getBattery?: () => Promise<{ level: number; charging: boolean }>;
};
type ScreenExtras = Screen & { isExtended?: boolean };
type WindowExtras = Window & { getScreenDetails?: () => Promise<{ screens: unknown[] }> };

/** Set by the workspace when it ever starts display capture itself (it never does today). */
let displayCaptureActive = false;
export function markDisplayCapture(active: boolean): void {
  displayCaptureActive = active;
}

function clampInt(n: number | undefined | null, max: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(max, Math.round(n)));
}

async function displayCount(win: WindowExtras): Promise<number | null> {
  // Only read the multi-screen API when the permission is already granted; the scan must never prompt.
  try {
    if (typeof win.getScreenDetails !== 'function' || !navigator.permissions?.query) return null;
    const status = await navigator.permissions.query({ name: 'window-management' as PermissionName });
    if (status.state !== 'granted') return null;
    const details = await win.getScreenDetails();
    return clampInt(details.screens.length, 16);
  } catch {
    return null;
  }
}

function gpuInfo(): { vendor: string | null; renderer: string | null } {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return { vendor: null, renderer: null };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = ext ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) ?? '') : String(gl.getParameter(gl.VENDOR) ?? '');
    const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '') : String(gl.getParameter(gl.RENDERER) ?? '');
    return { vendor: vendor.slice(0, 200) || null, renderer: renderer.slice(0, 300) || null };
  } catch {
    return { vendor: null, renderer: null };
  }
}

async function battery(nav: NavigatorExtras): Promise<DeviceScan['battery']> {
  try {
    if (typeof nav.getBattery !== 'function') return null;
    const b = await nav.getBattery();
    return { level: Math.max(0, Math.min(1, b.level)), charging: !!b.charging };
  } catch {
    return null;
  }
}

export async function collectDeviceScan(): Promise<DeviceScan> {
  const nav = navigator as NavigatorExtras;
  const scr = window.screen as ScreenExtras;
  const win = window as WindowExtras;
  const [count, bat] = await Promise.all([displayCount(win), battery(nav)]);
  const outerInnerGapW = window.outerWidth - window.innerWidth;
  const outerInnerGapH = window.outerHeight - window.innerHeight;
  let timezone: string | undefined;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    timezone = undefined;
  }
  const scan: DeviceScan = {
    takenAt: new Date().toISOString(),
    userAgent: String(nav.userAgent ?? '').slice(0, 512),
    platform: String(nav.platform ?? '').slice(0, 64) || undefined,
    language: String(nav.language ?? '').slice(0, 32) || undefined,
    timezone: timezone?.slice(0, 64),
    screen: {
      width: clampInt(scr.width, 20000),
      height: clampInt(scr.height, 20000),
      availWidth: clampInt(scr.availWidth, 20000),
      availHeight: clampInt(scr.availHeight, 20000),
      colorDepth: clampInt(scr.colorDepth, 64),
      pixelRatio: Math.max(0, Math.min(10, window.devicePixelRatio || 1)),
      isExtended: typeof scr.isExtended === 'boolean' ? scr.isExtended : null,
      displayCount: count,
    },
    window: { innerWidth: clampInt(window.innerWidth, 20000), innerHeight: clampInt(window.innerHeight, 20000), outerWidth: clampInt(window.outerWidth, 20000), outerHeight: clampInt(window.outerHeight, 20000) },
    hardware: {
      cores: typeof nav.hardwareConcurrency === 'number' ? clampInt(nav.hardwareConcurrency, 1024) : null,
      memoryGb: typeof nav.deviceMemory === 'number' ? Math.max(0, Math.min(1024, nav.deviceMemory)) : null,
      touchPoints: clampInt(nav.maxTouchPoints, 64),
      pointerFine: typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: fine)').matches : true,
    },
    gpu: gpuInfo(),
    browser: {
      webdriver: nav.webdriver === true,
      cookiesEnabled: nav.cookieEnabled !== false,
      fullscreenSupported: document.fullscreenEnabled === true,
      pdfViewer: typeof nav.pdfViewerEnabled === 'boolean' ? nav.pdfViewerEnabled : null,
      pluginsCount: clampInt(nav.plugins?.length ?? 0, 1000),
      displayCaptureActive,
      // Docked developer tools shrink the viewport well beyond normal window chrome.
      devtoolsHeuristic: outerInnerGapW > 160 || outerInnerGapH > 200,
    },
    network: {
      effectiveType: nav.connection?.effectiveType?.slice(0, 16) ?? null,
      downlinkMbps: typeof nav.connection?.downlink === 'number' ? Math.max(0, Math.min(100000, nav.connection.downlink)) : null,
      rttMs: typeof nav.connection?.rtt === 'number' ? Math.max(0, Math.min(100000, nav.connection.rtt)) : null,
      online: nav.onLine !== false,
    },
    battery: bat,
    visibility: (document.visibilityState as DeviceScan['visibility']) ?? 'visible',
  };
  return scan;
}
