import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { CANVAS_COLORS, CANVAS_LIMITS, DEFAULT_TEXT_SIZE, HIGHLIGHTER_OPACITY, SHAPE_FILL_OPACITY, type CanvasColor } from '@examos/contracts';
import type { CanvasContent, Stroke, StrokePoint } from '@/lib/answers';
import { cn } from '@/ui';
import { recognizeMathSymbol, type RecognizedSymbol } from './strokeRecognition';

export type DrawingTool = Stroke['tool'];
export type { CanvasColor, Stroke, StrokePoint };

export type EraserMode = 'area' | 'stroke';

export interface DrawingSurfaceProps {
  value: CanvasContent;
  onChange: (next: CanvasContent) => void;
  tool: DrawingTool;
  color?: CanvasColor;
  penWidth?: number;
  eraserWidth?: number;
  eraserMode?: EraserMode;
  /** Shapes only: translucent fill. */
  fill?: boolean;
  textSize?: number;
  readOnly?: boolean;
  label: string;
  className?: string;
  /** Called when a stroke was dropped because the drawing reached the contract's size limits. */
  onLimit?: () => void;
  /** Automatically converts recognized math symbols (e.g. √, ∫, ∑) and shapes */
  autoConvertMath?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
}

const MIN_POINT_DISTANCE = 1.5;
const SHAPE_TOOLS: readonly DrawingTool[] = ['line', 'arrow', 'rect', 'ellipse'];
const FREEHAND_TOOLS: readonly DrawingTool[] = ['pen', 'highlighter', 'eraser'];
const FONT_FAMILY = 'ui-sans-serif, system-ui, sans-serif';

function resolveColor(color: CanvasColor | undefined, ink: string): string {
  return (color ?? 'ink') === 'ink' ? ink : CANVAS_COLORS[color!];
}

function strokePath(ctx: CanvasRenderingContext2D, points: StrokePoint[]) {
  ctx.beginPath();
  const [x0, y0] = points[0]!;
  ctx.moveTo(x0, y0);
  if (points.length === 1) ctx.lineTo(x0 + 0.01, y0);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]![0], points[i]![1]);
  ctx.stroke();
}

/** Draws one item with the same geometry the SVG renderer uses (packages/contracts canvas-render). */
export function drawItem(ctx: CanvasRenderingContext2D, s: Stroke, ink: string) {
  if (s.points.length === 0) return;
  const color = resolveColor(s.color, ink);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = s.width;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.globalCompositeOperation = 'source-over';
  const p0 = s.points[0]!;
  const p1 = s.points[1] ?? p0;
  switch (s.tool) {
    case 'eraser':
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      strokePath(ctx, s.points);
      break;
    case 'highlighter':
      ctx.globalAlpha = HIGHLIGHTER_OPACITY;
      strokePath(ctx, s.points);
      break;
    case 'pen':
      strokePath(ctx, s.points);
      break;
    case 'line':
    case 'arrow': {
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      ctx.lineTo(p1[0], p1[1]);
      ctx.stroke();
      if (s.tool === 'arrow') {
        const angle = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
        const len = Math.max(10, s.width * 4);
        const spread = Math.PI / 7;
        ctx.beginPath();
        ctx.moveTo(p1[0], p1[1]);
        ctx.lineTo(p1[0] - len * Math.cos(angle - spread), p1[1] - len * Math.sin(angle - spread));
        ctx.lineTo(p1[0] - len * Math.cos(angle + spread), p1[1] - len * Math.sin(angle + spread));
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case 'rect': {
      const x = Math.min(p0[0], p1[0]);
      const y = Math.min(p0[1], p1[1]);
      const w = Math.abs(p1[0] - p0[0]);
      const h = Math.abs(p1[1] - p0[1]);
      if (s.fill) {
        ctx.globalAlpha = SHAPE_FILL_OPACITY;
        ctx.fillRect(x, y, w, h);
        ctx.globalAlpha = 1;
      }
      ctx.strokeRect(x, y, w, h);
      break;
    }
    case 'ellipse': {
      ctx.beginPath();
      ctx.ellipse((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, Math.abs(p1[0] - p0[0]) / 2, Math.abs(p1[1] - p0[1]) / 2, 0, 0, Math.PI * 2);
      if (s.fill) {
        ctx.globalAlpha = SHAPE_FILL_OPACITY;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.stroke();
      break;
    }
    case 'text': {
      const size = s.size ?? DEFAULT_TEXT_SIZE;
      ctx.font = `${size}px ${FONT_FAMILY}`;
      ctx.textBaseline = 'alphabetic';
      (s.text ?? '').split('\n').forEach((line, i) => ctx.fillText(line, p0[0], p0[1] + i * size * 1.25));
      break;
    }
  }
  ctx.restore();
}

export function renderStrokes(ctx: CanvasRenderingContext2D, content: CanvasContent, ink: string) {
  ctx.clearRect(0, 0, content.width, content.height);
  for (const s of content.strokes) drawItem(ctx, s, ink);
}

/** CSS background for the ruled/grid/dot paper; kept out of the bitmap so erasers never punch through it. */
function backgroundStyle(kind: CanvasContent['background'], scale = 1): CSSProperties {
  const c = 'color-mix(in srgb, var(--ink, #1a2030) 11%, transparent)';
  const s = (n: number) => `${n * scale}px`;
  switch (kind) {
    case 'grid':
      return { backgroundImage: `linear-gradient(${c} 1px, transparent 1px), linear-gradient(90deg, ${c} 1px, transparent 1px)`, backgroundSize: `${s(20)} ${s(20)}` };
    case 'ruled': {
      const marginRose = 'color-mix(in srgb, #f43f5e 38%, transparent)';
      const marginPos = s(56);
      return {
        backgroundImage: `linear-gradient(to right, transparent calc(${marginPos} - 1.5px), ${marginRose} calc(${marginPos} - 1.5px), ${marginRose} ${marginPos}, transparent ${marginPos}), linear-gradient(${c} 1px, transparent 1px)`,
        backgroundSize: `100% 100%, 100% ${s(28)}`,
        backgroundPosition: `0 0, 0 ${s(27)}`,
      };
    }
    case 'dots':
      return { backgroundImage: `radial-gradient(${c} 1px, transparent 1.5px)`, backgroundSize: `${s(20)} ${s(20)}`, backgroundPosition: `${s(10)} ${s(10)}` };
    default:
      return {};
  }
}

function pointsOf(content: CanvasContent): number {
  let n = 0;
  for (const s of content.strokes) n += s.points.length;
  return n;
}

/** True when one more item with `extraPoints` points still fits the contract's limits. */
export function fitsLimits(content: CanvasContent, extraPoints: number): boolean {
  return content.strokes.length < CANVAS_LIMITS.maxItems && pointsOf(content) + extraPoints <= CANVAS_LIMITS.maxTotalPoints && extraPoints <= CANVAS_LIMITS.maxPointsPerStroke;
}

/**
 * The whiteboard: a real <canvas> that accepts mouse, trackpad, touch and
 * stylus through Pointer Events. Freehand tools record point arrays (pressure
 * when the device reports it), shapes record two corners and text records an
 * anchor plus the typed string, so every item is a vector the booklet and the
 * PDF re-render identically. Erasing appends an eraser item; nothing is ever
 * rasterised or lost.
 */
export function createDigitalItemFromRecognition(candidate: RecognizedSymbol, stroke: Stroke, textSize = DEFAULT_TEXT_SIZE): Stroke {
  const color = stroke.color ?? 'ink';
  if (candidate.tool === 'rect') {
    return {
      tool: 'rect',
      width: Math.max(1.5, stroke.width),
      color,
      points: [
        [candidate.bounds.minX, candidate.bounds.minY],
        [candidate.bounds.maxX, candidate.bounds.maxY],
      ],
    };
  }
  if (candidate.tool === 'ellipse') {
    return {
      tool: 'ellipse',
      width: Math.max(1.5, stroke.width),
      color,
      points: [
        [candidate.bounds.minX, candidate.bounds.minY],
        [candidate.bounds.maxX, candidate.bounds.maxY],
      ],
    };
  }
  if (candidate.tool === 'line') {
    return {
      tool: 'line',
      width: Math.max(1.5, stroke.width),
      color,
      points: [stroke.points[0]!, stroke.points[stroke.points.length - 1]!],
    };
  }
  if (candidate.tool === 'arrow') {
    return {
      tool: 'arrow',
      width: Math.max(1.5, stroke.width),
      color,
      points: [stroke.points[0]!, stroke.points[stroke.points.length - 1]!],
    };
  }

  // Math symbol as digital text item
  const calculatedSize = Math.max(16, Math.min(64, Math.round(candidate.bounds.height * 0.95)));
  return {
    tool: 'text',
    width: 1,
    color,
    points: [[Math.round(candidate.bounds.minX), Math.round(candidate.bounds.minY + candidate.bounds.height * 0.88)]],
    text: candidate.symbol,
    size: calculatedSize || textSize,
  };
}

export function insertDigitalSymbolOnCanvas(
  content: CanvasContent,
  symbolOrFormula: string,
  options?: { x?: number; y?: number; size?: number; color?: CanvasColor }
): CanvasContent {
  const x = options?.x ?? Math.round(content.width * 0.35);
  const y = options?.y ?? Math.round(content.height * 0.45);
  const size = options?.size ?? DEFAULT_TEXT_SIZE;
  const color = options?.color ?? 'ink';
  const newItem: Stroke = {
    tool: 'text',
    width: 1,
    color,
    points: [[x, y]],
    text: symbolOrFormula,
    size,
  };
  return {
    ...content,
    strokes: [...content.strokes, newItem],
  };
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const l2 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}

export function findStrokeIndexAt(strokes: readonly Stroke[], p: StrokePoint, threshold = 12): number {
  const [px, py] = p;
  for (let idx = strokes.length - 1; idx >= 0; idx--) {
    const s = strokes[idx]!;
    const hitDist = threshold + (s.width || 2) / 2;
    if (s.tool === 'text') {
      const p0 = s.points[0];
      if (!p0) continue;
      const size = s.size ?? DEFAULT_TEXT_SIZE;
      const lines = (s.text ?? '').split('\n');
      const maxLen = Math.max(...lines.map((l) => l.length), 1);
      const textWidth = maxLen * (size * 0.6);
      const textHeight = lines.length * size * 1.25;
      if (px >= p0[0] - 6 && px <= p0[0] + textWidth + 6 && py >= p0[1] - size && py <= p0[1] + textHeight) {
        return idx;
      }
      continue;
    }

    if (s.tool === 'rect') {
      const [a, b] = s.points;
      if (!a || !b) continue;
      const x = Math.min(a[0], b[0]);
      const y = Math.min(a[1], b[1]);
      const w = Math.abs(b[0] - a[0]);
      const h = Math.abs(b[1] - a[1]);
      if (s.fill && px >= x && px <= x + w && py >= y && py <= y + h) return idx;
      if (
        distToSegment(px, py, x, y, x + w, y) <= hitDist ||
        distToSegment(px, py, x + w, y, x + w, y + h) <= hitDist ||
        distToSegment(px, py, x + w, y + h, x, y + h) <= hitDist ||
        distToSegment(px, py, x, y + h, x, y) <= hitDist
      ) {
        return idx;
      }
      continue;
    }

    if (s.tool === 'ellipse') {
      const [a, b] = s.points;
      if (!a || !b) continue;
      const cx = (a[0] + b[0]) / 2;
      const cy = (a[1] + b[1]) / 2;
      const rx = Math.max(1, Math.abs(b[0] - a[0]) / 2);
      const ry = Math.max(1, Math.abs(b[1] - a[1]) / 2);
      const norm = ((px - cx) ** 2) / (rx ** 2) + ((py - cy) ** 2) / (ry ** 2);
      if (s.fill && norm <= 1.1) return idx;
      const d = Math.abs(Math.sqrt(norm) - 1) * Math.min(rx, ry);
      if (d <= hitDist) return idx;
      continue;
    }

    const pts = s.points;
    if (pts.length === 1) {
      if (Math.hypot(px - pts[0]![0], py - pts[0]![1]) <= hitDist) return idx;
      continue;
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i]!;
      const p2 = pts[i + 1]!;
      if (distToSegment(px, py, p1[0], p1[1], p2[0], p2[1]) <= hitDist) {
        return idx;
      }
    }
  }
  return -1;
}

export function DrawingSurface({ value, onChange, tool, color = 'ink', penWidth = 2.25, eraserWidth = 18, eraserMode = 'area', fill = false, textSize = DEFAULT_TEXT_SIZE, readOnly = false, label, className, onLimit, autoConvertMath = false, onUndo, onRedo }: DrawingSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<Stroke | null>(null);
  const inkColor = useRef('#1a2030');
  const [textDraft, setTextDraft] = useState<{ x: number; y: number; value: string } | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const [recognitionPrompt, setRecognitionPrompt] = useState<{
    candidate: RecognizedSymbol;
    strokeIndex: number;
    digitalItem: Stroke;
  } | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

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
    if (liveRef.current) drawItem(ctx, liveRef.current, inkColor.current);
  }, [value]);

  useEffect(() => {
    try {
      inkColor.current = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#1a2030';
    } catch {
      /* non-browser */
    }
    redraw();
  }, [redraw]);

  useEffect(() => {
    if (textDraft) textRef.current?.focus();
  }, [textDraft]);

  const toPoint = (e: ReactPointerEvent<HTMLElement>): StrokePoint => {
    const rect = e.currentTarget.getBoundingClientRect();
    // Without layout (tests, hidden tabs) client pixels map 1:1 onto canvas units.
    const sx = rect.width ? value.width / rect.width : 1;
    const sy = rect.height ? value.height / rect.height : 1;
    const x = Math.max(0, Math.min(value.width, (e.clientX - rect.left) * sx));
    const y = Math.max(0, Math.min(value.height, (e.clientY - rect.top) * sy));
    const r = (n: number) => Math.round(n * 10) / 10;
    return e.pointerType === 'pen' && e.pressure > 0 && tool === 'pen' ? [r(x), r(y), Math.round(e.pressure * 100) / 100] : [r(x), r(y)];
  };

  const commit = (item: Stroke) => {
    if (!fitsLimits(value, item.points.length)) {
      onLimit?.();
      return;
    }
    onChange({ ...value, strokes: [...value.strokes, item] });
  };

  const commitText = () => {
    const draft = textDraft;
    setTextDraft(null);
    const text = draft?.value.replace(/\s+$/, '') ?? '';
    if (!draft || !text) return;
    commit({ tool: 'text', width: 1, color, points: [[draft.x, draft.y]], text: text.slice(0, CANVAS_LIMITS.maxTextLength), size: textSize });
  };

  const applyRecognition = () => {
    if (!recognitionPrompt) return;
    const { strokeIndex, digitalItem } = recognitionPrompt;
    setRecognitionPrompt(null);
    const strokes = [...value.strokes];
    if (strokeIndex < strokes.length) {
      strokes[strokeIndex] = digitalItem;
      onChange({ ...value, strokes });
    }
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (readOnly || e.button !== 0) return;
    if (recognitionPrompt) {
      setRecognitionPrompt(null);
    }
    if (textDraft) {
      commitText();
      return;
    }
    const p = toPoint(e);
    if (tool === 'eraser' && eraserMode === 'stroke') {
      const hitRadius = Math.max(10, eraserWidth / 2);
      const hitIndex = findStrokeIndexAt(value.strokes, p, hitRadius);
      if (hitIndex >= 0) {
        const nextStrokes = value.strokes.filter((_, idx) => idx !== hitIndex);
        onChange({ ...value, strokes: nextStrokes });
      }
      return;
    }
    if (tool === 'text') {
      setTextDraft({ x: p[0], y: p[1], value: '' });
      return;
    }
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* capture unsupported */
    }
    const width = tool === 'eraser' ? eraserWidth : tool === 'highlighter' ? penWidth * 6 : penWidth;
    const base: Stroke = { tool, width, points: [p] };
    if (tool !== 'eraser') base.color = color;
    if (SHAPE_TOOLS.includes(tool)) {
      base.points = [p, p];
      if (fill && (tool === 'rect' || tool === 'ellipse')) base.fill = true;
    }
    liveRef.current = base;
    redraw();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (tool === 'eraser' && !readOnly) {
      const rect = e.currentTarget.getBoundingClientRect();
      setHoverPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      if (eraserMode === 'stroke' && (e.buttons === 1 || e.pressure > 0)) {
        const p = toPoint(e);
        const hitRadius = Math.max(10, eraserWidth / 2);
        const hitIndex = findStrokeIndexAt(value.strokes, p, hitRadius);
        if (hitIndex >= 0) {
          const nextStrokes = value.strokes.filter((_, idx) => idx !== hitIndex);
          onChange({ ...value, strokes: nextStrokes });
        }
        return;
      }
    }
    const live = liveRef.current;
    if (!live) return;
    const p = toPoint(e);
    if (SHAPE_TOOLS.includes(live.tool)) {
      live.points[1] = p;
      redraw();
      return;
    }
    const last = live.points[live.points.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < MIN_POINT_DISTANCE) return;
    if (live.points.length >= CANVAS_LIMITS.maxPointsPerStroke) return;
    live.points.push(p);
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx && last) {
      // Incremental segment for a fluid line; the full item is redrawn on commit.
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = live.width;
      if (live.tool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)';
      } else {
        ctx.strokeStyle = resolveColor(live.color, inkColor.current);
        if (live.tool === 'highlighter') ctx.globalAlpha = HIGHLIGHTER_OPACITY;
      }
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
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      /* already released */
    }
    if (SHAPE_TOOLS.includes(live.tool)) {
      const [a, b] = live.points as [StrokePoint, StrokePoint];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 2) {
        redraw();
        return; // a click, not a shape
      }
    }

    if (live.tool === 'pen' && live.points.length >= 5) {
      const candidate = recognizeMathSymbol(live, value.strokes);
      if (candidate) {
        const digitalItem = createDigitalItemFromRecognition(candidate, live, textSize);
        if (autoConvertMath) {
          commit(digitalItem);
          return;
        }
        commit(live);
        setRecognitionPrompt({
          candidate,
          strokeIndex: value.strokes.length,
          digitalItem,
        });
        return;
      }
    }

    commit(live);
  };

  const onTextKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setTextDraft(null);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitText();
    }
  };

  const count = value.strokes.filter((s) => s.tool !== 'eraser').length;
  const cursor = readOnly ? 'default' : tool === 'text' ? 'text' : FREEHAND_TOOLS.includes(tool) ? 'crosshair' : 'cell';
  return (
    <div className={cn('relative', className)} style={{ aspectRatio: `${value.width} / ${value.height}` }}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`${label}. ${count} ${count === 1 ? 'item' : 'items'}.`}
        data-tool={tool}
        tabIndex={0}
        style={{ width: '100%', height: '100%', touchAction: 'none', cursor, ...backgroundStyle(value.background) }}
        className="block bg-sheet rounded-sm outline-none focus:ring-1 focus:ring-accent"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onPointerLeave={(e) => {
          setHoverPos(null);
          if (liveRef.current) finish(e);
        }}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
          const mod = isMac ? e.metaKey : e.ctrlKey;
          if (!mod) return;
          const key = e.key.toLowerCase();
          if (key === 'z' && !e.shiftKey) {
            if (onUndo) {
              e.preventDefault();
              e.stopPropagation();
              onUndo();
            }
          } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
            if (onRedo) {
              e.preventDefault();
              e.stopPropagation();
              onRedo();
            }
          }
        }}
      />
      {tool === 'eraser' && hoverPos && !readOnly ? (
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute rounded-full -translate-x-1/2 -translate-y-1/2 border z-10',
            eraserMode === 'stroke' ? 'border-accent bg-accent/20' : 'border-stop/80 bg-stop/10'
          )}
          style={{
            left: hoverPos.x,
            top: hoverPos.y,
            width: eraserWidth,
            height: eraserWidth,
          }}
        />
      ) : null}
      {textDraft ? (
        <textarea
          ref={textRef}
          aria-label="Text to place on the diagram"
          value={textDraft.value}
          onChange={(e) => setTextDraft({ ...textDraft, value: e.target.value.slice(0, CANVAS_LIMITS.maxTextLength) })}
          onKeyDown={onTextKey}
          onBlur={commitText}
          rows={1}
          placeholder="Type, then Enter"
          className="absolute bg-sheet/95 border border-accent rounded-sm px-1 text-ink outline-none resize-none"
          style={{ left: `${(textDraft.x / value.width) * 100}%`, top: `${(textDraft.y / value.height) * 100}%`, transform: 'translateY(-1.1em)', fontSize: `${Math.max(12, textSize * 0.9)}px`, minWidth: '8rem', fontFamily: FONT_FAMILY, color: resolveColor(color, inkColor.current) }}
        />
      ) : null}
      {recognitionPrompt && !readOnly ? (
        <div
          role="status"
          aria-live="polite"
          className="absolute z-20 flex items-center gap-1.5 bg-sheet/95 backdrop-blur-sm border border-accent/80 rounded px-2 py-1 shadow-lg text-xs animate-in fade-in select-none"
          style={{
            left: `${Math.max(2, Math.min(80, (recognitionPrompt.candidate.bounds.minX / value.width) * 100))}%`,
            top: `${Math.max(2, ((recognitionPrompt.candidate.bounds.minY - 38) / value.height) * 100)}%`,
          }}
        >
          <span className="font-serif font-bold text-accent text-sm select-none">
            {recognitionPrompt.candidate.symbol}
          </span>
          <span className="text-ink-2 truncate max-w-32 hidden sm:inline select-none">
            {recognitionPrompt.candidate.name}
          </span>
          <button
            type="button"
            onClick={applyRecognition}
            className="bg-accent text-white px-2 py-0.5 rounded font-medium text-xs hover:bg-accent/90 transition-colors shadow-xs cursor-pointer"
          >
            Convert
          </button>
          <button
            type="button"
            onClick={() => setRecognitionPrompt(null)}
            className="text-ink-3 hover:text-ink px-1 text-xs cursor-pointer"
            aria-label="Dismiss symbol suggestion"
          >
            ✕
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function undoLastStroke(content: CanvasContent): CanvasContent {
  return { ...content, strokes: content.strokes.slice(0, -1) };
}

export function emptyCanvas(width = 800, height = 480, background: CanvasContent['background'] = undefined): CanvasContent {
  return background ? { width, height, background, strokes: [] } : { width, height, strokes: [] };
}
