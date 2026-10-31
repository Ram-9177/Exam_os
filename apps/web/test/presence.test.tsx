import { useMemo } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { SignalReporter, type SignalEvent } from '@/lib/signals';
import { PresenceTracker } from '@/features/exam/presence-tracker';
import { SelfView, useCameraPresence } from '@/features/exam/presence';
import type { FrameAnalyser } from '@/features/exam/presence-detector';
import { describeSignal } from '@/features/proctor/signal-text';

const seq = (tracker: PresenceTracker, frames: Array<[number, number, number?]>) => frames.flatMap(([at, faces, lum = 0.5]) => tracker.observe({ at, faces, luminance: lum }));

describe('presence tracker (on-device, per-second samples)', () => {
  it('a glance away is nothing; eight seconds without a face is a signal, and the return carries the total', () => {
    const t = new PresenceTracker();
    expect(seq(t, [[0, 1], [1000, 0], [3000, 0], [4000, 1], [5000, 1], [6000, 1]])).toEqual([]);
    const out = seq(t, [[10_000, 0], [14_000, 0], [18_000, 0], [25_000, 0], [31_000, 1], [32_000, 1], [33_000, 1]]);
    expect(out).toEqual([
      { signal: 'FACE_NOT_VISIBLE', metadata: { phase: 'started', reason: 'no-face', seconds: 8 } },
      { signal: 'FACE_NOT_VISIBLE', metadata: { phase: 'returned', reason: 'no-face', seconds: 21 }, force: true },
    ]);
    expect(describeSignal({ signal_class: 'FACE_NOT_VISIBLE', metadata: out[1]!.metadata, source_id: 'CLIENT:u' })).toBe('Reported by the student’s browser: no face was in view for 21 s. Detected on the student’s device; no image was sent.');
  });

  it('a single stray detection (poster, shadow) does not end an absence; three face frames in a row do', () => {
    const t = new PresenceTracker();
    const out = seq(t, [[0, 0], [2000, 1], [3000, 0], [5000, 1], [6000, 0], [8000, 0], [9000, 1], [10_000, 1], [11_000, 0], [12_000, 1], [13_000, 1], [14_000, 1]]);
    expect(out).toEqual([
      { signal: 'FACE_NOT_VISIBLE', metadata: { phase: 'started', reason: 'no-face', seconds: 8 } },
      { signal: 'FACE_NOT_VISIBLE', metadata: { phase: 'returned', reason: 'no-face', seconds: 12 }, force: true },
    ]);
  });

  it('a covered or blacked-out camera is reported as covered, even if the detector still guesses a face', () => {
    const t = new PresenceTracker();
    const out = seq(t, [[0, 1, 0.01], [5000, 1, 0.02], [9000, 0, 0.01]]);
    expect(out).toEqual([{ signal: 'FACE_NOT_VISIBLE', metadata: { phase: 'started', reason: 'covered', seconds: 9 } }]);
  });

  it('a second face for three seconds is one signal per episode, with the most faces seen', () => {
    const t = new PresenceTracker();
    expect(seq(t, [[0, 2], [1000, 1]])).toEqual([]); // someone walking past
    const out = seq(t, [[5000, 2], [6000, 3], [8000, 2], [9000, 2], [12_000, 2]]);
    expect(out).toEqual([{ signal: 'MULTIPLE_PERSON_POSSIBLE', metadata: { faces: 3, seconds: 3 } }]);
    expect(seq(t, [[13_000, 1], [14_000, 2], [17_500, 2]])).toEqual([{ signal: 'MULTIPLE_PERSON_POSSIBLE', metadata: { faces: 2, seconds: 4 } }]);
  });
});

function Harness({ sent, enabled = true, analyser }: { sent: SignalEvent[]; enabled?: boolean; analyser: () => Promise<FrameAnalyser> }) {
  const reporter = useMemo(() => new SignalReporter({ attemptId: 'a1', send: async (evs) => void sent.push(...evs) }), [sent]);
  const { status, stream } = useCameraPresence({ enabled, active: true, reporter, loadAnalyser: analyser });
  return <SelfView stream={stream} status={status} />;
}

describe('camera presence in the workspace', () => {
  const stopped: string[] = [];
  const fakeStream = () => {
    const track = Object.assign(new EventTarget(), { stop: () => stopped.push('video'), kind: 'video' });
    return { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  };
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    stopped.length = 0;
    delete (navigator as unknown as Record<string, unknown>)['mediaDevices'];
  });

  it('samples the local camera, reports a sustained absence, shows the student the check is on, and stops the camera after', async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => fakeStream()) } });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, get: () => 4 });
    let faces = 1;
    const analyser = async (): Promise<FrameAnalyser> => ({ analyse: () => ({ faces, luminance: 0.4 }), close: () => undefined });
    const sent: SignalEvent[] = [];
    const view = render(<Harness sent={sent} analyser={analyser} />);
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(screen.getByLabelText('Camera presence check')).toHaveTextContent('No images are sent or kept');
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ video: { width: 320, height: 240, facingMode: 'user' }, audio: false });
    faces = 0;
    await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
    expect(sent.map((e) => [e.signalClass, e.metadata['phase']])).toEqual([['FACE_NOT_VISIBLE', 'started']]);
    view.unmount();
    expect(stopped).toEqual(['video']);
  });

  it('a denied or missing camera is a technical signal; the exam carries on and the student is told', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => Promise.reject(new DOMException('no', 'NotAllowedError'))) } });
    const sent: SignalEvent[] = [];
    render(<Harness sent={sent} analyser={async () => ({ analyse: () => ({ faces: 1, luminance: 1 }), close: () => undefined })} />);
    expect(await screen.findByText(/Camera unavailable — the invigilator has been informed/)).toBeInTheDocument();
    expect(sent.map((e) => [e.signalClass, e.metadata])).toEqual([['CAMERA_UNAVAILABLE', { reason: 'permission-denied' }]]);
  });

  it('is never started for an exam that did not turn it on', async () => {
    const gum = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: gum } });
    const { container } = render(<Harness sent={[]} enabled={false} analyser={async () => ({ analyse: () => ({ faces: 1, luminance: 1 }), close: () => undefined })} />);
    expect(gum).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });
});
