import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { SignalReporter } from '@/lib/signals';
import { Button, Stamp } from '@/ui';

/**
 * Screen watch: when the exam turns it on, the student shares the ENTIRE screen while writing and a small picture of
 * it goes to the proctors every intervalSeconds, so a person can see an AI app, a chat or notes next to the exam.
 * Nothing is judged automatically. Stopping the share, or sharing only a window or tab, hides the paper until the
 * entire screen is shared again and is reported (SCREEN_SHARE_ENDED). The server measures gaps between pictures itself.
 *
 * Limits, said plainly: some "invisible" AI overlays ask the operating system to leave them out of screen capture, so
 * they never appear in the pictures. Safe Exam Browser (which closes them by process) is the control for those.
 */
export type ScreenWatchStatus = 'off' | 'needs-share' | 'sharing' | 'unsupported';

type DisplayMediaOptions = DisplayMediaStreamOptions & { selfBrowserSurface?: string; surfaceSwitching?: string; monitorTypeSurfaces?: string };
type Surface = 'monitor' | 'window' | 'browser' | 'unknown';

const MAX_WIDTH = 1280;
const MAX_DATA_URL = 540_000;

export interface ScreenWatchOptions {
  enabled: boolean;
  active: boolean;
  attemptId: string;
  intervalSeconds: number;
  reporter: SignalReporter;
  /** test seam: grab one JPEG data URL from the stream */
  grab?: (stream: MediaStream) => Promise<{ image: string; width: number; height: number } | null>;
}

async function grabFrame(stream: MediaStream): Promise<{ image: string; width: number; height: number } | null> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
    if (!video.videoWidth) await new Promise((r) => setTimeout(r, 300));
    const scale = Math.min(1, MAX_WIDTH / (video.videoWidth || MAX_WIDTH));
    for (const [s, q] of [[scale, 0.6], [scale * 0.75, 0.45], [scale * 0.5, 0.4]] as const) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * s));
      canvas.height = Math.max(1, Math.round(video.videoHeight * s));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = canvas.toDataURL('image/jpeg', q);
      if (image.length <= MAX_DATA_URL) return { image, width: canvas.width, height: canvas.height };
    }
    return null;
  } finally {
    video.pause();
    video.srcObject = null;
  }
}

export function useScreenWatch({ enabled, active, attemptId, intervalSeconds, reporter, grab = grabFrame }: ScreenWatchOptions) {
  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
  const [status, setStatus] = useState<ScreenWatchStatus>(enabled ? (supported ? 'needs-share' : 'unsupported') : 'off');
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const surfaceRef = useRef<Surface>('unknown');
  const startedAt = useRef(0);
  const reportedUnsupported = useRef(false);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    streamRef.current = null;
  }, []);

  useEffect(() => {
    if (!enabled) return setStatus('off');
    if (!supported) {
      setStatus('unsupported');
      // a phone or tablet cannot share its screen: on record for the proctor, never blocking the student
      if (active && !reportedUnsupported.current) {
        reportedUnsupported.current = true;
        reporter.report('SCREEN_SHARE_ENDED', { reason: 'unsupported' }, { force: true });
      }
      return;
    }
    if (!streamRef.current) setStatus('needs-share');
  }, [enabled, supported, active, reporter]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'monitor', frameRate: 1 }, audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'include' } as DisplayMediaOptions);
      const track = stream.getVideoTracks()[0];
      const surface = ((track?.getSettings() as MediaTrackSettings & { displaySurface?: string })?.displaySurface ?? 'unknown') as Surface;
      if (surface !== 'monitor' && surface !== 'unknown') {
        stream.getTracks().forEach((t) => t.stop());
        reporter.report('SCREEN_SHARE_ENDED', { reason: 'not-entire-screen', surface }, { force: true });
        setError(`You shared a ${surface === 'browser' ? 'tab' : 'window'}. Choose “Entire screen” instead.`);
        setStatus('needs-share');
        return;
      }
      surfaceRef.current = surface;
      startedAt.current = Date.now();
      streamRef.current = stream;
      if (track) {
        track.onended = () => {
          streamRef.current = null;
          setStatus('needs-share');
          reporter.report('SCREEN_SHARE_ENDED', { reason: 'stopped', afterSeconds: Math.round((Date.now() - startedAt.current) / 1000) }, { force: true });
        };
      }
      setStatus('sharing');
    } catch (e) {
      reporter.report('SCREEN_SHARE_ENDED', { reason: 'refused', error: e instanceof Error ? e.name : 'unknown' }, { force: true });
      setError('Screen sharing was not allowed. The exam needs it: press the button again and choose “Entire screen”.');
      setStatus('needs-share');
    }
  }, [reporter]);

  // the pictures: one at once, then every intervalSeconds, only while live and sharing
  useEffect(() => {
    if (status !== 'sharing' || !active) return;
    let cancelled = false;
    const send = async () => {
      const stream = streamRef.current;
      if (!stream || cancelled) return;
      try {
        const frame = await grab(stream);
        if (frame && !cancelled) await api.post(`/student/attempts/${attemptId}/screen-frames`, { ...frame, displaySurface: surfaceRef.current }, { quiet: true });
      } catch {
        /* a lost picture is a gap the server sees; it never interrupts writing */
      }
    };
    void send();
    const timer = setInterval(() => void send(), Math.max(15, intervalSeconds) * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [status, active, attemptId, intervalSeconds, grab]);

  // sharing ends with the attempt (submitted, closed, left the page)
  useEffect(() => {
    if (!active) stop();
  }, [active, stop]);
  useEffect(() => stop, [stop]);

  return { status, error, start };
}

/** Covers the paper until the entire screen is shared. */
export function ScreenShareGate({ onShare, error }: { onShare: () => void; error: string | null }) {
  return (
    <div className="fixed inset-0 z-40 bg-paper grid place-items-center p-6" role="alertdialog" aria-modal="true" aria-labelledby="ss-title" aria-describedby="ss-body">
      <div className="max-w-md text-center">
        <Stamp tone="fix" className="text-3xl">
          Screen
        </Stamp>
        <h2 id="ss-title" className="text-h2 mt-6">
          Share your entire screen
        </h2>
        <p id="ss-body" className="mt-3 text-ink-2">
          This exam is watched by your invigilators: a small picture of your screen goes to them every so often while you write. Choose <strong>Entire screen</strong> (not a window or tab). The paper is hidden until you share; stopping the share is recorded.
        </p>
        {error ? (
          <p className="mt-3 text-fix" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-6 flex justify-center">
          <Button variant="primary" onClick={onShare} data-autofocus>
            Share entire screen
          </Button>
        </div>
      </div>
    </div>
  );
}
