import { useId } from 'react';
import type { CanvasContent, Stroke } from '@/lib/answers';

function pathOf(s: Stroke): string {
  if (s.points.length === 0) return '';
  const [x0, y0] = s.points[0]!;
  if (s.points.length === 1) return `M${x0} ${y0} L${x0 + 0.01} ${y0}`;
  return `M${x0} ${y0} ` + s.points.slice(1).map(([x, y]) => `L${x} ${y}`).join(' ');
}

/**
 * Vector re-render of a canvas block for the booklet and print. Pen strokes are
 * drawn in ink; eraser strokes punch through via a mask, matching the canvas's
 * destination-out behaviour.
 */
export function StrokesSvg({ content, className, label = 'Diagram' }: { content: CanvasContent; className?: string; label?: string }) {
  const maskId = useId();
  const pens = content.strokes.filter((s) => s.tool === 'pen');
  const erasers = content.strokes.filter((s) => s.tool === 'eraser');
  return (
    <svg viewBox={`0 0 ${content.width} ${content.height}`} role="img" aria-label={`${label}, ${pens.length} strokes`} className={className} style={{ width: '100%', height: 'auto', display: 'block' }}>
      {erasers.length > 0 ? (
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={content.width} height={content.height}>
            <rect x="0" y="0" width={content.width} height={content.height} fill="#fff" />
            {erasers.map((s, i) => (
              <path key={i} d={pathOf(s)} stroke="#000" strokeWidth={s.width} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            ))}
          </mask>
        </defs>
      ) : null}
      <g mask={erasers.length > 0 ? `url(#${maskId})` : undefined}>
        {pens.map((s, i) => (
          <path key={i} d={pathOf(s)} stroke="currentColor" strokeWidth={s.width} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        ))}
      </g>
    </svg>
  );
}
