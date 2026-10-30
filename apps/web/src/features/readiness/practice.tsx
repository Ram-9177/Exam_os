import { useEffect, useRef, useState } from 'react';
import type { CanvasContent } from '@/lib/answers';
import { keyboardSampleOk } from '@/lib/readiness';
import { Button, Checkbox, Field, TextArea } from '@/ui';
import { DrawingSurface, emptyCanvas, undoLastStroke, type DrawingTool } from '@/features/drawing/DrawingSurface';

export const KEYBOARD_SAMPLE = 'The quick brown fox jumps over 13 lazy dogs; ready, set, go!';

/**
 * Keyboard practice: a functional test that letters, digits, punctuation and
 * correction keys work. Nothing about speed is measured or shown (spec §29).
 */
export function KeyboardPractice({ value, onChange, onSubmit, busy }: { value: string; onChange: (v: string) => void; onSubmit: () => void; busy: boolean }) {
  const check = keyboardSampleOk(value);
  return (
    <div className="flex flex-col gap-4">
      <p>
        Type the sample below into the box. Take your time — speed is not measured and corrections are fine. Use Backspace at least once if you like.
      </p>
      <p className="font-serif text-xl leading-relaxed border-l-2 border-rule-2 pl-4" style={{ fontVariationSettings: "'opsz' 24" }}>
        {KEYBOARD_SAMPLE}
      </p>
      <Field label="Practice box" hint={check.ok ? 'Letters, digits and punctuation detected.' : `Still needed: ${check.missing.join(', ')}.`}>
        {({ id, describedBy }) => <TextArea id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={describedBy} rows={3} autoComplete="off" spellCheck={false} data-autofocus />}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onSubmit} disabled={!check.ok} loading={busy}>
          Check keyboard
        </Button>
        <Button variant="ghost" onClick={() => onChange('')} disabled={!value}>
          Clear
        </Button>
      </div>
    </div>
  );
}

/** Drawing practice: a circle, a box and an arrow with whatever pointing device the student has. Stylus is optional. */
export function CanvasPractice({ onSubmit, onSkip, busy }: { onSubmit: (ops: number) => void; onSkip: () => void; busy: boolean }) {
  const [content, setContent] = useState<CanvasContent>(() => emptyCanvas(640, 320));
  const [tool, setTool] = useState<DrawingTool>('pen');
  const strokes = content.strokes.length;
  return (
    <div className="flex flex-col gap-4">
      <p>
        Draw a circle, a box and an arrow. A mouse or trackpad is enough; <strong>a stylus is optional</strong>. Use the eraser and undo once so you know where they are.
      </p>
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Drawing tools">
        <Button size="sm" variant={tool === 'pen' ? 'primary' : 'secondary'} aria-pressed={tool === 'pen'} onClick={() => setTool('pen')}>
          Pen
        </Button>
        <Button size="sm" variant={tool === 'eraser' ? 'primary' : 'secondary'} aria-pressed={tool === 'eraser'} onClick={() => setTool('eraser')}>
          Eraser
        </Button>
        <Button size="sm" onClick={() => setContent(undoLastStroke(content))} disabled={strokes === 0}>
          Undo
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setContent(emptyCanvas(640, 320))} disabled={strokes === 0}>
          Clear
        </Button>
        <span className="ml-auto text-sm text-ink-2 tabular" aria-live="polite">
          {strokes} {strokes === 1 ? 'stroke' : 'strokes'}
        </span>
      </div>
      <div className="border border-rule-2 rounded-sm overflow-hidden">
        <DrawingSurface value={content} onChange={setContent} tool={tool} label="Practice canvas" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => onSubmit(strokes)} disabled={strokes < 3} loading={busy}>
          Check drawing
        </Button>
        <Button variant="ghost" onClick={onSkip} disabled={busy}>
          Skip — I will type my answers
        </Button>
      </div>
    </div>
  );
}

/** Monitoring notice and consent, recorded against the exam's policy version. */
export function ConsentStep({ notice, purposes, policyVersion, onSubmit, busy }: { notice: string; purposes: string[]; policyVersion: string; onSubmit: () => void; busy: boolean }) {
  const [agreed, setAgreed] = useState(false);
  const list = purposes.length ? purposes.map((p) => p.toLowerCase()).join(' and ') : 'device signals';
  return (
    <div className="flex flex-col gap-4">
      <div className="sheet p-4 bg-sheet-2">
        <p className="font-medium mb-1">Monitoring notice</p>
        <p className="text-ink-2">{notice}</p>
        <p className="text-sm text-ink-2 mt-2">
          For this exam: {list}. Policy version {policyVersion}.
        </p>
      </div>
      <Checkbox label="I have read the monitoring notice for this exam" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} data-autofocus />
      <div>
        <Button variant="primary" onClick={onSubmit} disabled={!agreed} loading={busy}>
          Record my acknowledgement
        </Button>
      </div>
    </div>
  );
}

/** Camera / microphone preview. Only after a working preview does the client declare the check. */
export function MediaStep({ kind, onConfirm, onCannot, busy }: { kind: 'CAMERA' | 'MICROPHONE'; onConfirm: () => void; onCannot: () => void; busy: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const isCamera = kind === 'CAMERA';

  useEffect(() => {
    return () => {
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [stream]);

  useEffect(() => {
    if (!stream || isCamera) return;
    const Ctx = window.AudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;
    const loop = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += Math.abs(v - 128);
      setLevel(Math.min(1, sum / data.length / 40));
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      void ctx.close();
    };
  }, [stream, isCamera]);

  const request = async () => {
    setError(null);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
      const s = await navigator.mediaDevices.getUserMedia(isCamera ? { video: { facingMode: 'user' }, audio: false } : { audio: true, video: false });
      setStream(s);
      if (isCamera && videoRef.current) {
        videoRef.current.srcObject = s;
        await videoRef.current.play().catch(() => undefined);
      }
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      if (name === 'NotAllowedError') setError(isCamera ? 'Camera access was blocked. Allow it in the browser prompt or the address bar, then try again.' : 'Microphone access was blocked. Allow it in the browser prompt or the address bar, then try again.');
      else if (name === 'NotFoundError' || name === 'OverconstrainedError') setError(isCamera ? 'No camera was found. Ask the desk for a loaner USB webcam.' : 'No microphone was found. Ask the desk for help.');
      else setError(isCamera ? 'The camera could not start. Close other apps using it, then try again.' : 'The microphone could not start. Close other apps using it, then try again.');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p>{isCamera ? 'Allow camera access and check that your face is in the frame. Lighting does not need to be perfect.' : 'Allow microphone access. Room noise is expected and is not a problem.'}</p>
      {isCamera ? (
        <video ref={videoRef} muted playsInline className="w-full max-w-md aspect-video bg-sheet-2 rounded-sm border border-rule" aria-label="Camera preview" />
      ) : (
        <div className="w-full max-w-md">
          <div className="h-3 bg-sheet-2 rounded-sm border border-rule overflow-hidden" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
            <div className="h-full bg-accent transition-[width] duration-100" style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
          <p className="text-sm text-ink-2 mt-1">{stream ? 'Say a few words; the bar should move.' : 'The level shows once the microphone is allowed.'}</p>
        </div>
      )}
      {error ? (
        <p className="text-fix" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!stream ? (
          <Button variant="primary" onClick={() => void request()} data-autofocus>
            {isCamera ? 'Allow camera' : 'Allow microphone'}
          </Button>
        ) : (
          <Button variant="primary" onClick={onConfirm} loading={busy}>
            {isCamera ? 'I can see myself' : 'I can see the level move'}
          </Button>
        )}
        <Button variant="ghost" onClick={onCannot} disabled={busy}>
          {isCamera ? 'I have no working camera' : 'I have no working microphone'}
        </Button>
      </div>
    </div>
  );
}
