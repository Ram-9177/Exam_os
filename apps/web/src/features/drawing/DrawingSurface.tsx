import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { CanvasContent, Stroke, StrokePoint } from '@/lib/answers';
import { cn } from '@/ui';

export type DrawingTool = 'pen' | 'eraser';

export interface DrawingSurfaceProps {
  value: CanvasContent;
  onChange: (next: CanvasContent) => void;
  tool: DrawingTool;
  penWidth?: number;
  eraserWidth?: number;
  readOnly?: boolean;
  label: string;
  className?: string;
}

const MIN_POINT_DISTANCE = 1.5;

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, color: string) {
  if (s.points.length === 0) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = s.width;
  if (s.tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = color;
  }
  ctx.beginPath();
  const [x0, y0] = s.points[0]!;
  ctx.moveTo(x0, y0);
  if (s.points.length === 1) ctx.lineTo(x0 + 0.01, y0);
  for (let i = 1; i < s.points.length; i++) {
    const [x, y] = s.points[i]!;
    ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

export function renderStrokes(ctx: CanvasRenderingContext2D, content: CanvasContent, color: string) {
  ctx.clearRect(0, 0, content.width, content.height);
  for (const s of content.strokes) drawStroke(ctx, s, color);
}

/**
 * A real <canvas> that accepts mouse, trackpad, touch and stylus through
 * Pointer Events. Strokes are stored as point arrays (vector source, spec §7)
 * so they can be re-rendered in the booklet. Erasing appends an eraser stroke;
 * undo removes the last stroke. No pressure is required; it is recorded when the
 * device reports it.
 */
export function DrawingSurface({ value, onChange, tool, penWidth = 2.25, eraserWidth = 18, readOnly = false, label, className }: DrawingSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<Stroke | null>(null);
  const inkColor = useRef('#1a2030');

  const redraw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    if (c.width !== Math.round(value.width * dpr) || c.height !== Math.round(value.height * dpr)) {
      c.width = Math.round(value.width * dpr);
      c.height = Math.round(value.height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderStrokes(ctx, value, inkColor.current);
    if (liveRef.current) drawStroke(ctx, liveRef.current, inkColor.current);
  }, [value]);

  useEffect(() => {
    try {
      inkColor.current = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#1a2030';
    } catch {
      /* non-browser */
    }
    redraw();
  }, [redraw]);

  const toPoint = (e: ReactPointerEvent<HTMLCanvasElement>): StrokePoint => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * value.width;
    const y = ((e.clientY - rect.top) / rect.height) * value.height;
    const r = (n: number) => Math.round(n * 10) / 10;
    return e.pointerType === 'pen' && e.pressure > 0 ? [r(x), r(y), Math.round(e.pressure * 100) / 100] : [r(x), r(y)];
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (readOnly || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    liveRef.current = { tool, width: tool === 'eraser' ? eraserWidth : penWidth, points: [toPoint(e)] };
    redraw();
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const live = liveRef.current;
    if (!live) return;
    const p = toPoint(e);
    const last = live.points[live.points.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < MIN_POINT_DISTANCE) return;
    live.points.push(p);
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx && last) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = live.width;
      ctx.globalCompositeOperation = live.tool === 'eraser' ? 'destination-out' : 'source-over';
      ctx.strokeStyle = live.tool === 'eraser' ? 'rgba(0,0,0,1)' : inkColor.current;
      ctx.beginPath();
      ctx.moveTo(last[0], last[1]);
      ctx.lineTo(p[0], p[1]);
      ctx.stroke();
      ctx.restore();
    }
  };
  const finish = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const live = liveRef.current;
    if (!live) return;
    liveRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    onChange({ ...value, strokes: [...value.strokes, live] });
  };

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={`${label}. ${value.strokes.length} ${value.strokes.length === 1 ? 'stroke' : 'strokes'}.`}
      style={{ width: '100%', aspectRatio: `${value.width} / ${value.height}`, touchAction: 'none', cursor: readOnly ? 'default' : 'crosshair' }}
      className={cn('block bg-sheet rounded-sm', className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onPointerLeave={(e) => {
        if (liveRef.current) finish(e);
      }}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}

export function undoLastStroke(content: CanvasContent): CanvasContent {
  return { ...content, strokes: content.strokes.slice(0, -1) };
}

export function emptyCanvas(width = 800, height = 480): CanvasContent {
  return { width, height, strokes: [] };
}
