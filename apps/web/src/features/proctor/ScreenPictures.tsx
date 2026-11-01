import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, fetchObjectUrl } from '@/lib/api';
import { formatTime } from '@/lib/time';
import { Badge } from '@/ui';

interface ScreenFrames {
  enabled: boolean;
  intervalSeconds: number | null;
  lastFrameAt: string | null;
  secondsSinceLastFrame: number | null;
  overdue: boolean;
  gaps: Array<{ from: string; to: string; seconds: number }>;
  frames: Array<{ id: string; receivedAt: string; displaySurface: string; entireScreen: boolean; width: number; height: number }>;
}

function Picture({ id, alt, className }: { id: string; alt: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let live = true;
    fetchObjectUrl(`/proctor/screen-frames/${id}.jpg`)
      .then((u) => {
        url = u;
        if (live) setSrc(u);
        else URL.revokeObjectURL(u);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);
  return src ? <img src={src} alt={alt} className={className} /> : <div className={`${className ?? ''} bg-sheet-2`} aria-label={`${alt} (loading)`} />;
}

/**
 * The student's screen as the proctor sees it (screen watch): newest pictures first, the arrival times by the server's
 * clock, and gaps longer than twice the interval. A person looks; nothing here is a verdict.
 */
export function ScreenPictures({ attemptId, tz }: { attemptId: string; tz: string }) {
  const q = useQuery({ queryKey: ['proctor', 'screen', attemptId], queryFn: () => api.get<ScreenFrames>(`/proctor/attempts/${attemptId}/screen-frames`), refetchInterval: 30_000 });
  const [open, setOpen] = useState<string | null>(null);
  const d = q.data;
  if (!d || (!d.enabled && !d.frames.length)) return null;
  const shown = d.frames.slice(0, 12);
  const big = d.frames.find((f) => f.id === open) ?? null;
  return (
    <section className="flex flex-col gap-2" aria-labelledby="screen-h">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="screen-h" className="text-h3">
          Screen
        </h3>
        {d.overdue ? <Badge tone="stop">No picture for {d.secondsSinceLastFrame !== null ? `${Math.round(d.secondsSinceLastFrame / 60)} min` : 'this attempt yet'}</Badge> : d.lastFrameAt ? <Badge tone="ready">Last picture {formatTime(d.lastFrameAt, tz)}</Badge> : null}
        {d.intervalSeconds ? <span className="text-sm text-ink-2">one every {d.intervalSeconds} s</span> : null}
      </div>
      {d.gaps.length ? (
        <p className="text-sm text-fix">
          {d.gaps.length} gap{d.gaps.length === 1 ? '' : 's'}: {d.gaps.slice(0, 3).map((g) => `${formatTime(g.from, tz)}–${formatTime(g.to, tz)} (${Math.round(g.seconds / 60)} min)`).join(', ')}
          {d.gaps.length > 3 ? ', …' : ''}
        </p>
      ) : null}
      {big ? (
        <figure className="border border-rule-2 rounded-sm">
          <Picture id={big.id} alt={`Screen at ${formatTime(big.receivedAt, tz)}`} className="w-full h-auto" />
          <figcaption className="text-xs text-ink-2 p-2 flex justify-between">
            <span>
              {formatTime(big.receivedAt, tz)} · {big.entireScreen ? 'entire screen' : `${big.displaySurface} only`}
            </span>
            <button type="button" className="underline" onClick={() => setOpen(null)}>
              Close
            </button>
          </figcaption>
        </figure>
      ) : null}
      {shown.length ? (
        <ul className="grid grid-cols-3 sm:grid-cols-4 gap-2" aria-label="Screen pictures">
          {shown.map((f) => (
            <li key={f.id}>
              <button type="button" onClick={() => setOpen(f.id)} className="block w-full text-left" aria-label={`Open screen picture from ${formatTime(f.receivedAt, tz)}`}>
                <Picture id={f.id} alt={`Screen at ${formatTime(f.receivedAt, tz)}`} className="w-full aspect-video object-cover rounded-sm border border-rule" />
                <span className={f.entireScreen ? 'text-xs text-ink-2' : 'text-xs text-fix'}>
                  {formatTime(f.receivedAt, tz)}
                  {f.entireScreen ? '' : ' · not entire screen'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-2">No pictures yet.</p>
      )}
    </section>
  );
}
