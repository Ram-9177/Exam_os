import { useCallback, useEffect, useRef, useState } from 'react';
import { uuid } from '@/lib/ids';
import type { SignalReporter } from '@/lib/signals';

/**
 * Browser-mode lockdown for the exam workspace.
 *
 * A web page cannot close or block other applications; Safe Exam Browser does that (SECURE_BYOD). What a page can do,
 * this does: require full screen before the paper is shown, hide the paper whenever the window is not the active one,
 * capture system keys where the browser allows (Keyboard Lock), and report every departure — tab hidden, another app
 * focused, full screen left, display changed, a second tab, split-screen, print/PrintScreen — with the context a human
 * needs (reason, time away, display before/after). Every report is context for a person; none counts by itself.
 */
export interface LockdownOptions {
  attemptId: string;
  /** True while the attempt is live on this device (session kind 'active'). Nothing is reported otherwise. */
  active: boolean;
  reporter: SignalReporter;
  /** Called when the display configuration changes, so the workspace can run a server-derived device scan at once. */
  onDisplayChange?: () => void;
  /** Called when a restricted shortcut was blocked (DevTools, view source, print, save). */
  onRestricted?: (kind: 'devtools' | 'source-or-print') => void;
  /** Debounce before a departure is reported, so a sub-second focus flicker is not a signal. */
  leaveDebounceMs?: number;
}

export interface LockdownState {
  fullscreenSupported: boolean;
  inFullscreen: boolean;
  /** Full screen was requested and refused by this device; the student continues and the refusal is on record. */
  fullscreenWaived: boolean;
  /** The window is not the active one right now: the paper is hidden. */
  away: boolean;
  /** Other tabs/windows of this same attempt currently open in this browser. */
  otherTabs: number;
}

export interface DisplaySnapshot {
  width: number;
  height: number;
  availWidth: number;
  availHeight: number;
  colorDepth: number;
  pixelRatio: number;
  extended: boolean | null;
}

type ScreenExtras = Screen & { isExtended?: boolean; addEventListener?: (type: 'change', fn: () => void) => void; removeEventListener?: (type: 'change', fn: () => void) => void };
type NavigatorExtras = Navigator & { keyboard?: { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void } };

export function displaySnapshot(win: Window = window): DisplaySnapshot {
  const s = win.screen as ScreenExtras;
  return {
    width: s?.width ?? 0,
    height: s?.height ?? 0,
    availWidth: s?.availWidth ?? 0,
    availHeight: s?.availHeight ?? 0,
    colorDepth: s?.colorDepth ?? 0,
    pixelRatio: Math.round((win.devicePixelRatio || 1) * 100) / 100,
    extended: typeof s?.isExtended === 'boolean' ? s.isExtended : null,
  };
}

/** What changed between two snapshots, as a signal (or null when nothing a human would care about changed). */
export function classifyDisplayChange(from: DisplaySnapshot, to: DisplaySnapshot): { signal: 'DUAL_SCREEN_DETECTED' | 'DISPLAY_CHANGED'; metadata: Record<string, unknown> } | null {
  if (to.extended === true && from.extended !== true) return { signal: 'DUAL_SCREEN_DETECTED', metadata: { source: 'screen-change', from, to } };
  const changed = from.width !== to.width || from.height !== to.height || from.colorDepth !== to.colorDepth || from.pixelRatio !== to.pixelRatio || from.extended !== to.extended;
  return changed ? { signal: 'DISPLAY_CHANGED', metadata: { from, to } } : null;
}

export function fullscreenSupported(doc: Document = document): boolean {
  return typeof doc.documentElement?.requestFullscreen === 'function' && doc.fullscreenEnabled !== false;
}

export function useLockdown({ attemptId, active, reporter, onDisplayChange, onRestricted, leaveDebounceMs = 300 }: LockdownOptions) {
  const supported = fullscreenSupported();
  const [inFullscreen, setInFullscreen] = useState(() => typeof document !== 'undefined' && !!document.fullscreenElement);
  const [fullscreenWaived, setFullscreenWaived] = useState(false);
  const [away, setAway] = useState(false);
  const [otherTabs, setOtherTabs] = useState(0);

  const activeRef = useRef(active);
  activeRef.current = active;
  const displayRef = useRef<() => void>(() => undefined);
  displayRef.current = onDisplayChange ?? (() => undefined);
  const restrictedRef = useRef(onRestricted);
  restrictedRef.current = onRestricted;

  // ---------- full screen (gate + exit/restore reports + keyboard lock) ----------
  const exitedAt = useRef<number | null>(null);
  useEffect(() => {
    const nav = navigator as NavigatorExtras;
    const onChange = () => {
      const now = !!document.fullscreenElement;
      setInFullscreen(now);
      if (now) {
        // Capture Escape, Alt+Tab, the Windows/Command key etc. where the browser supports it (Chromium, full screen only).
        void nav.keyboard?.lock?.().catch(() => undefined);
        if (exitedAt.current !== null && activeRef.current) reporter.report('FULLSCREEN_EXIT', { phase: 'restored', outsideMs: Date.now() - exitedAt.current }, { force: true });
        exitedAt.current = null;
      } else {
        nav.keyboard?.unlock?.();
        if (activeRef.current) {
          exitedAt.current = Date.now();
          reporter.report('FULLSCREEN_EXIT', { phase: 'exited' });
        }
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [reporter]);

  const enterFullscreen = useCallback(async () => {
    if (!supported) return;
    try {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      // Refused by the device or the browser: never trap a student outside their exam. Continue, on the record.
      setFullscreenWaived(true);
      if (activeRef.current) reporter.report('FULLSCREEN_EXIT', { phase: 'refused' }, { force: true });
    }
  }, [reporter, supported]);

  // ---------- departures: tab hidden / another window focused, with time away ----------
  useEffect(() => {
    if (!active) {
      setAway(false);
      return;
    }
    let episode: { id: string; startedAt: number; reason: 'tab-hidden' | 'window-blur'; reported: boolean; timer: ReturnType<typeof setTimeout> | null } | null = null;
    const isBack = () => document.visibilityState !== 'hidden' && (typeof document.hasFocus !== 'function' || document.hasFocus());
    const leave = (reason: 'tab-hidden' | 'window-blur') => {
      setAway(true);
      if (episode) {
        if (reason === 'tab-hidden') episode.reason = 'tab-hidden';
        return;
      }
      const ep = { id: uuid(), startedAt: Date.now(), reason, reported: false, timer: null as ReturnType<typeof setTimeout> | null };
      ep.timer = setTimeout(() => {
        ep.reported = true;
        reporter.report('FOCUS_LOST', { phase: 'left', reason: document.visibilityState === 'hidden' ? 'tab-hidden' : ep.reason, episode: ep.id }, { force: true });
      }, leaveDebounceMs);
      episode = ep;
    };
    const back = () => {
      if (!isBack()) return;
      setAway(false);
      const ep = episode;
      episode = null;
      if (!ep) return;
      if (ep.timer) clearTimeout(ep.timer);
      if (ep.reported) reporter.report('FOCUS_LOST', { phase: 'returned', reason: ep.reason, awayMs: Date.now() - ep.startedAt, episode: ep.id }, { force: true });
    };
    const onVisibility = () => (document.visibilityState === 'hidden' ? leave('tab-hidden') : back());
    const onBlur = () => leave('window-blur');
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', back);
    if (!isBack()) leave(document.visibilityState === 'hidden' ? 'tab-hidden' : 'window-blur');
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', back);
      if (episode?.timer) clearTimeout(episode.timer);
    };
  }, [active, reporter, leaveDebounceMs]);

  // ---------- display configuration: second screen, projector/mirroring, resolution, scaling ----------
  useEffect(() => {
    if (!active) return;
    let last = displaySnapshot();
    const check = () => {
      const next = displaySnapshot();
      const change = classifyDisplayChange(last, next);
      last = next;
      if (!change) return;
      reporter.report(change.signal, change.metadata);
      displayRef.current();
    };
    const scr = window.screen as ScreenExtras;
    scr?.addEventListener?.('change', check);
    window.addEventListener('resize', check);
    // devicePixelRatio has no event of its own: watch the media query for the current ratio and re-arm on change.
    let mq: MediaQueryList | null = null;
    const arm = () => {
      mq?.removeEventListener?.('change', onRatio);
      mq = typeof window.matchMedia === 'function' ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`) : null;
      mq?.addEventListener?.('change', onRatio);
    };
    function onRatio() {
      check();
      arm();
    }
    arm();
    // With the window-management permission already granted (asked at readiness, never mid-exam), count screens exactly.
    let details: (EventTarget & { screens: unknown[] }) | null = null;
    const onScreens = () => {
      const n = details?.screens.length ?? 0;
      if (n > 1) reporter.report('DUAL_SCREEN_DETECTED', { source: 'screen-details', screens: n });
      else reporter.report('DISPLAY_CHANGED', { source: 'screen-details', to: { ...displaySnapshot(), screens: n } });
      displayRef.current();
    };
    const win = window as Window & { getScreenDetails?: () => Promise<EventTarget & { screens: unknown[] }> };
    void (async () => {
      try {
        if (typeof win.getScreenDetails !== 'function' || !navigator.permissions?.query) return;
        const st = await navigator.permissions.query({ name: 'window-management' as PermissionName });
        if (st.state !== 'granted') return;
        details = await win.getScreenDetails();
        details.addEventListener('screenschange', onScreens);
      } catch {
        /* not available: the screen change event above still covers isExtended */
      }
    })();
    return () => {
      scr?.removeEventListener?.('change', check);
      window.removeEventListener('resize', check);
      mq?.removeEventListener?.('change', onRatio);
      details?.removeEventListener('screenschange', onScreens);
    };
  }, [active, reporter]);

  // ---------- the same attempt open in another tab or window of this browser ----------
  useEffect(() => {
    if (!active || typeof BroadcastChannel === 'undefined') return;
    const me = uuid();
    const others = new Set<string>();
    const ch = new BroadcastChannel(`examos.attempt.${attemptId}`);
    const seen = (tab: string) => {
      if (tab === me || others.has(tab)) return;
      others.add(tab);
      setOtherTabs(others.size);
      reporter.report('MULTIPLE_TABS', { tabs: others.size + 1 });
    };
    ch.onmessage = (e: MessageEvent<{ type: 'hello' | 'here' | 'bye'; tab: string }>) => {
      const m = e.data;
      if (!m || typeof m.tab !== 'string') return;
      if (m.type === 'bye') {
        others.delete(m.tab);
        setOtherTabs(others.size);
        return;
      }
      if (m.type === 'hello') ch.postMessage({ type: 'here', tab: me });
      seen(m.tab);
    };
    ch.postMessage({ type: 'hello', tab: me });
    return () => {
      ch.postMessage({ type: 'bye', tab: me });
      ch.close();
      setOtherTabs(0);
    };
  }, [active, attemptId, reporter]);

  // ---------- split screen / shrunken window (outside full screen) ----------
  useEffect(() => {
    if (!active) return;
    let small = false;
    let t: ReturnType<typeof setTimeout> | null = null;
    const evaluate = () => {
      if (document.fullscreenElement) return;
      const s = window.screen;
      if (!s?.availWidth || !s.availHeight) return;
      const now = window.outerWidth < s.availWidth * 0.9 || window.outerHeight < s.availHeight * 0.85;
      if (now && !small) reporter.report('WINDOW_RESIZED', { outer: `${window.outerWidth}×${window.outerHeight}`, avail: `${s.availWidth}×${s.availHeight}` });
      small = now;
    };
    const onResize = () => {
      if (t) clearTimeout(t);
      t = setTimeout(evaluate, 800);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (t) clearTimeout(t);
    };
  }, [active, reporter]);

  // ---------- restricted shortcuts, context menu, print and PrintScreen ----------
  useEffect(() => {
    if (!active) return;
    const onContextMenu = (e: MouseEvent) => e.preventDefault(); // blocked, not reported
    const onKeyDown = (e: KeyboardEvent) => {
      const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const key = e.key.toLowerCase();
      const isDevTools = e.key === 'F12' || (mod && e.shiftKey && (key === 'i' || key === 'j' || key === 'c')) || (isMac && e.altKey && e.metaKey && (key === 'i' || key === 'j' || key === 'c'));
      const isSourceOrPrint = mod && (key === 'u' || key === 'p' || key === 's');
      if (isDevTools || isSourceOrPrint) {
        e.preventDefault();
        e.stopPropagation();
        restrictedRef.current?.(isDevTools ? 'devtools' : 'source-or-print');
        if (isDevTools) reporter.report('DEVTOOLS_ATTEMPT', { key: e.key });
        else if (key === 'p') reporter.report('SCREEN_CAPTURE_ATTEMPT', { kind: 'print' });
      }
    };
    // PrintScreen arrives as keyup on most systems; wipe what it may have put on the clipboard.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'PrintScreen') return;
      reporter.report('SCREEN_CAPTURE_ATTEMPT', { kind: 'printscreen-key' });
      void navigator.clipboard?.writeText?.('').catch(() => undefined);
    };
    const onBeforePrint = () => reporter.report('SCREEN_CAPTURE_ATTEMPT', { kind: 'print' });
    document.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    window.addEventListener('beforeprint', onBeforePrint);
    return () => {
      document.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
      window.removeEventListener('beforeprint', onBeforePrint);
    };
  }, [active, reporter]);

  const state: LockdownState = { fullscreenSupported: supported, inFullscreen, fullscreenWaived, away, otherTabs };
  return { state, enterFullscreen, needsFullscreen: active && supported && !inFullscreen && !fullscreenWaived };
}
