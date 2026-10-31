import { useEffect, useRef, useState } from 'react';
import type { SignalReporter } from '@/lib/signals';
import { PresenceTracker } from './presence-tracker';
import type { FrameAnalyser } from './presence-detector';

export type PresenceStatus = 'off' | 'starting' | 'on' | 'unavailable';
const SAMPLE_MS = 1_000;

/**
 * On-device camera presence check for exams that turned it on. The camera stream stays in this tab; a face detector
 * running locally counts faces once a second. Sustained absence, a covered camera or a second face become signals for
 * the proctors; a camera that cannot start or stops is a technical signal (never countable). The exam never stops
 * because of the camera.
 */
export function useCameraPresence({ enabled, active, reporter, loadAnalyser = defaultAnalyser }: { enabled: boolean; active: boolean; reporter: SignalReporter; loadAnalyser?: () => Promise<FrameAnalyser> }) {
  const [status, setStatus] = useState<PresenceStatus>('off');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const loaderRef = useRef(loadAnalyser);
  loaderRef.current = loadAnalyser;

  useEffect(() => {
    if (!enabled || !active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let media: MediaStream | null = null;
    let analyser: FrameAnalyser | null = null;
    const unavailable = (reason: string) => {
      if (cancelled) return;
      setStatus('unavailable');
      reporter.report('CAMERA_UNAVAILABLE', { reason });
    };
    setStatus('starting');
    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) return unavailable('no-camera-api');
      try {
        media = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: 'user' }, audio: false });
      } catch (e) {
        const name = e instanceof DOMException ? e.name : '';
        return unavailable(name === 'NotAllowedError' ? 'permission-denied' : name === 'NotFoundError' ? 'no-camera' : 'camera-error');
      }
      if (cancelled) return media.getTracks().forEach((t) => t.stop());
      const track = media.getVideoTracks()[0];
      track?.addEventListener('ended', () => unavailable('ended'));
      setStream(media);
      try {
        analyser = await loaderRef.current();
      } catch {
        return unavailable('detector-failed');
      }
      if (cancelled) return;
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = media;
      await video.play().catch(() => undefined);
      const tracker = new PresenceTracker();
      setStatus('on');
      let failures = 0;
      let started = false;
      let waits = 0;
      timer = setInterval(() => {
        if (!analyser) return;
        if (video.readyState < 2) {
          if (++waits === 15) console.warn('[examos] camera presence: no video frames yet', video.readyState, video.paused);
          return;
        }
        const at = performance.now();
        try {
          const o = analyser.analyse(video, at);
          if (!started) {
            started = true;
            console.info('[examos] camera presence check running on this device');
          }
          failures = 0;
          for (const e of tracker.observe({ at, ...o })) reporter.report(e.signal, e.metadata, { force: e.force });
        } catch (err) {
          // One bad frame is not a signal; a detector that keeps failing is a technical gap the proctor must know about.
          if (++failures === 10) {
            console.warn('[examos] camera presence check failed repeatedly', err);
            unavailable('detector-error');
          }
        }
      }, SAMPLE_MS);
    })();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      analyser?.close();
      media?.getTracks().forEach((t) => t.stop());
      setStream(null);
      setStatus('off');
    };
  }, [enabled, active, reporter]);

  return { status, stream };
}

async function defaultAnalyser(): Promise<FrameAnalyser> {
  const { createFrameAnalyser } = await import('./presence-detector');
  return createFrameAnalyser();
}

/** The student always sees that the camera check is running, and that nothing is recorded. */
export function SelfView({ stream, status }: { stream: MediaStream | null; status: PresenceStatus }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && stream) ref.current.srcObject = stream;
  }, [stream]);
  if (status === 'off') return null;
  return (
    <figure className="fixed bottom-20 right-4 z-30 w-36 rounded-md border border-rule-2 bg-sheet shadow-sm overflow-hidden" aria-label="Camera presence check">
      {stream ? <video ref={ref} autoPlay muted playsInline className="w-full aspect-[4/3] object-cover -scale-x-100 bg-ink" /> : <div className="w-full aspect-[4/3] bg-sheet-2" />}
      <figcaption className="px-2 py-1 text-[11px] leading-tight text-ink-2">
        {status === 'unavailable' ? 'Camera unavailable — the invigilator has been informed. Keep writing.' : 'Presence check on this device. No images are sent or kept.'}
      </figcaption>
    </figure>
  );
}
