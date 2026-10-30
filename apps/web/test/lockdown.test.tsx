import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SignalReporter, type SignalEvent } from '@/lib/signals';
import { classifyDisplayChange, displaySnapshot, useLockdown } from '@/features/exam/lockdown';
import { describeSignal } from '@/features/proctor/signal-text';

function Harness({ sent, active = true, onDisplay, attemptId = 'a1' }: { sent: SignalEvent[]; active?: boolean; onDisplay?: () => void; attemptId?: string }) {
  const reporter = useMemo(() => new SignalReporter({ attemptId, send: async (evs) => void sent.push(...evs) }), [attemptId, sent]);
  const { state, needsFullscreen, enterFullscreen } = useLockdown({ attemptId, active, reporter, onDisplayChange: onDisplay });
  return (
    <div>
      <p data-testid="state">{JSON.stringify({ ...state, needsFullscreen })}</p>
      <button type="button" onClick={() => void enterFullscreen()}>
        enter
      </button>
    </div>
  );
}
const state = () => JSON.parse(screen.getByTestId('state').textContent ?? '{}') as Record<string, unknown>;
const classes = (sent: SignalEvent[]) => sent.map((e) => e.signalClass);

let hasFocus = true;
let visibility: DocumentVisibilityState = 'visible';
beforeEach(() => {
  hasFocus = true;
  visibility = 'visible';
  vi.spyOn(document, 'hasFocus').mockImplementation(() => hasFocus);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('lockdown: leaving the exam window or tab', () => {
  it('reports the departure with its reason and, on return, the time away; the paper is hidden meanwhile', () => {
    vi.useFakeTimers();
    const sent: SignalEvent[] = [];
    render(<Harness sent={sent} />);
    hasFocus = false;
    act(() => void window.dispatchEvent(new Event('blur')));
    expect(state()['away']).toBe(true);
    visibility = 'hidden';
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    act(() => void vi.advanceTimersByTime(400));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ signalClass: 'FOCUS_LOST', metadata: { phase: 'left', reason: 'tab-hidden' } });

    act(() => void vi.advanceTimersByTime(41_600));
    visibility = 'visible';
    hasFocus = true;
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(state()['away']).toBe(false);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.metadata).toMatchObject({ phase: 'returned', reason: 'tab-hidden', episode: sent[0]!.metadata['episode'] });
    expect(sent[1]!.metadata['awayMs']).toBeGreaterThanOrEqual(42_000);
    expect(describeSignal({ signal_class: 'FOCUS_LOST', metadata: sent[1]!.metadata, source_id: 'CLIENT:u' })).toBe('Reported by the student’s browser: returned to the exam after 42 s away. The exam tab was hidden (another tab, minimised or the screen locked).');
  });

  it('a sub-second focus flicker is not a signal, and nothing is reported while the attempt is not live', () => {
    vi.useFakeTimers();
    const sent: SignalEvent[] = [];
    const { rerender } = render(<Harness sent={sent} />);
    hasFocus = false;
    act(() => void window.dispatchEvent(new Event('blur')));
    act(() => void vi.advanceTimersByTime(100));
    hasFocus = true;
    act(() => void window.dispatchEvent(new Event('focus')));
    act(() => void vi.advanceTimersByTime(1000));
    expect(sent).toEqual([]);

    rerender(<Harness sent={sent} active={false} />);
    hasFocus = false;
    act(() => void window.dispatchEvent(new Event('blur')));
    act(() => void vi.advanceTimersByTime(1000));
    expect(sent).toEqual([]);
    expect(state()['away']).toBe(false);
  });
});

describe('lockdown: display changes', () => {
  const base = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelRatio: 1, extended: false };
  it('classifies a second screen, a projector/mirroring resolution change, and no change', () => {
    expect(classifyDisplayChange(base, { ...base, extended: true })?.signal).toBe('DUAL_SCREEN_DETECTED');
    expect(classifyDisplayChange(base, { ...base, width: 1024, height: 768, availWidth: 1024, availHeight: 728 })).toMatchObject({ signal: 'DISPLAY_CHANGED', metadata: { from: { width: 1920 }, to: { width: 1024 } } });
    expect(classifyDisplayChange(base, { ...base, pixelRatio: 1.25 })?.signal).toBe('DISPLAY_CHANGED');
    expect(classifyDisplayChange(base, { ...base })).toBeNull();
  });

  it('reports a change on the screen change event and asks for a device scan at once', () => {
    const sent: SignalEvent[] = [];
    const onDisplay = vi.fn();
    const scr = window.screen as Screen & { isExtended?: boolean };
    const w0 = scr.width;
    render(<Harness sent={sent} onDisplay={onDisplay} />);
    Object.defineProperty(scr, 'width', { configurable: true, get: () => 1024 });
    act(() => void (scr as unknown as EventTarget).dispatchEvent?.(new Event('change')));
    // jsdom's Screen may not be an EventTarget; the resize path covers the same check
    if (!sent.length) act(() => void window.dispatchEvent(new Event('resize')));
    expect(classes(sent)).toEqual(['DISPLAY_CHANGED']);
    expect(sent[0]!.metadata).toMatchObject({ from: { width: w0 }, to: { width: 1024 } });
    expect(onDisplay).toHaveBeenCalledTimes(1);
    expect(describeSignal({ signal_class: 'DISPLAY_CHANGED', metadata: sent[0]!.metadata, source_id: 'CLIENT:u' })).toContain('to 1024×');
    Object.defineProperty(scr, 'width', { configurable: true, get: () => w0 });
    expect(displaySnapshot().width).toBe(w0);
  });
});

describe('lockdown: a second tab of the same attempt', () => {
  it('both tabs see each other, report MULTIPLE_TABS and show the warning; closing one clears it', async () => {
    const sentA: SignalEvent[] = [];
    const sentB: SignalEvent[] = [];
    const a = render(<Harness sent={sentA} />);
    const b = render(<Harness sent={sentB} />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(classes(sentA)).toContain('MULTIPLE_TABS');
    expect(classes(sentB)).toContain('MULTIPLE_TABS');
    expect(JSON.parse(a.getAllByTestId('state')[0]!.textContent!).otherTabs).toBe(1);
    b.unmount();
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(JSON.parse(a.getByTestId('state').textContent!).otherTabs).toBe(0);
  });
});

describe('lockdown: full screen', () => {
  let fsEl: Element | null = null;
  beforeEach(() => {
    fsEl = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fsEl });
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true });
  });
  afterEach(() => {
    delete (document.documentElement as unknown as Record<string, unknown>)['requestFullscreen'];
  });

  it('gates the paper until full screen, then reports an exit and the restore with the time outside', async () => {
    (document.documentElement as unknown as { requestFullscreen: () => Promise<void> }).requestFullscreen = async () => {
      fsEl = document.documentElement;
      document.dispatchEvent(new Event('fullscreenchange'));
    };
    const sent: SignalEvent[] = [];
    render(<Harness sent={sent} />);
    expect(state()['needsFullscreen']).toBe(true);
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'enter' })));
    expect(state()).toMatchObject({ needsFullscreen: false, inFullscreen: true });
    expect(sent).toEqual([]); // entering the first time is not a signal

    fsEl = null;
    act(() => void document.dispatchEvent(new Event('fullscreenchange')));
    expect(state()['needsFullscreen']).toBe(true);
    expect(sent.at(-1)).toMatchObject({ signalClass: 'FULLSCREEN_EXIT', metadata: { phase: 'exited' } });
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'enter' })));
    expect(sent.at(-1)).toMatchObject({ signalClass: 'FULLSCREEN_EXIT', metadata: { phase: 'restored' } });
    expect(typeof sent.at(-1)!.metadata['outsideMs']).toBe('number');
  });

  it('never traps a student when the device refuses full screen: continues, on the record', async () => {
    (document.documentElement as unknown as { requestFullscreen: () => Promise<void> }).requestFullscreen = () => Promise.reject(new Error('denied'));
    const sent: SignalEvent[] = [];
    render(<Harness sent={sent} />);
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'enter' })));
    expect(state()).toMatchObject({ needsFullscreen: false, fullscreenWaived: true });
    expect(sent).toEqual([expect.objectContaining({ signalClass: 'FULLSCREEN_EXIT', metadata: { phase: 'refused' } })]);
  });
});

describe('lockdown: capture and inspection attempts', () => {
  it('blocks print and DevTools shortcuts and reports them; PrintScreen and the print menu are reported', () => {
    const sent: SignalEvent[] = [];
    render(<Harness sent={sent} />);
    const print = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, cancelable: true, bubbles: true });
    window.dispatchEvent(print);
    expect(print.defaultPrevented).toBe(true);
    const f12 = new KeyboardEvent('keydown', { key: 'F12', cancelable: true, bubbles: true });
    window.dispatchEvent(f12);
    expect(f12.defaultPrevented).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'PrintScreen', bubbles: true }));
    expect(classes(sent)).toEqual(['SCREEN_CAPTURE_ATTEMPT', 'DEVTOOLS_ATTEMPT']);
    expect(sent[0]!.metadata).toEqual({ kind: 'print' });
    // the PrintScreen report falls inside the 5 s window of the print report: one incident, not a flood
    const sent2: SignalEvent[] = [];
    render(<Harness sent={sent2} attemptId="a2" />);
    window.dispatchEvent(new Event('beforeprint'));
    expect(sent2.map((e) => e.metadata)).toEqual([{ kind: 'print' }]);
  });
});
