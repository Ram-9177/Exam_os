import { CANVAS_COLORS, type CanvasColor, type CanvasContentWire } from './api.js';

/**
 * Canonical vector rendering of a whiteboard (canvas) answer block.
 *
 * One pure builder serves the student's workspace, the evaluator's booklet,
 * the printed booklet and the server-rendered PDF, so every reader sees the
 * same drawing. Eraser semantics follow the live canvas (destination-out): an
 * eraser only removes what was drawn before it, so items are grouped into
 * segments and each segment is masked by the erasers that came after it.
 */
export type CanvasItem = CanvasContentWire['strokes'][number];

export interface CanvasSceneBackground {
  kind: 'blank' | 'grid' | 'ruled' | 'dots';
  spacing: number;
  color: string;
}

export interface CanvasSceneSegment {
  items: CanvasItem[];
  erasers: CanvasItem[];
}

export interface CanvasScene {
  width: number;
  height: number;
  background: CanvasSceneBackground;
  segments: CanvasSceneSegment[];
  /** Items that leave visible marks (everything except erasers). */
  visibleCount: number;
}

export const CANVAS_DEFAULT_COLOR: CanvasColor = 'ink';
export const HIGHLIGHTER_OPACITY = 0.35;
export const SHAPE_FILL_OPACITY = 0.15;
export const DEFAULT_TEXT_SIZE = 18;
const BACKGROUND_SPACING = { grid: 20, ruled: 28, dots: 20 } as const;

export function canvasColorHex(color: CanvasColor | undefined, inkColor?: string): string {
  const key = color ?? CANVAS_DEFAULT_COLOR;
  return key === 'ink' && inkColor ? inkColor : CANVAS_COLORS[key];
}

export function buildCanvasScene(content: CanvasContentWire): CanvasScene {
  const segments: CanvasSceneSegment[] = [];
  let visibleCount = 0;
  let current: CanvasSceneSegment | null = null;
  for (const item of content.strokes) {
    if (item.tool === 'eraser') {
      for (const seg of segments) seg.erasers.push(item);
      current = null;
      continue;
    }
    if (!current) {
      current = { items: [], erasers: [] };
      segments.push(current);
    }
    current.items.push(item);
    visibleCount++;
  }
  const kind = content.background ?? 'blank';
  return {
    width: content.width,
    height: content.height,
    background: { kind, spacing: kind === 'blank' ? 0 : BACKGROUND_SPACING[kind], color: '#d6dae3' },
    segments,
    visibleCount,
  };
}

export function strokePathData(points: CanvasItem['points']): string {
  if (points.length === 0) return '';
  const [x0, y0] = points[0]!;
  if (points.length === 1) return `M${x0} ${y0} L${x0 + 0.01} ${y0}`;
  let d = `M${x0} ${y0}`;
  for (let i = 1; i < points.length; i++) d += ` L${points[i]![0]} ${points[i]![1]}`;
  return d;
}

/** Arrow head as a closed path at the end of p0→p1. */
export function arrowHeadPathData(p0: readonly number[], p1: readonly number[], width: number): string {
  const angle = Math.atan2(p1[1]! - p0[1]!, p1[0]! - p0[0]!);
  const len = Math.max(10, width * 4);
  const spread = Math.PI / 7;
  const ax = p1[0]! - len * Math.cos(angle - spread);
  const ay = p1[1]! - len * Math.sin(angle - spread);
  const bx = p1[0]! - len * Math.cos(angle + spread);
  const by = p1[1]! - len * Math.sin(angle + spread);
  return `M${p1[0]} ${p1[1]} L${ax} ${ay} L${bx} ${by} Z`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** SVG markup for one visible item. */
export function canvasItemSvg(item: CanvasItem, inkColor?: string): string {
  const color = canvasColorHex(item.color, inkColor);
  const common = `stroke="${color}" stroke-width="${num(item.width)}" stroke-linecap="round" stroke-linejoin="round"`;
  const p0 = item.points[0]!;
  const p1 = item.points[1] ?? p0;
  switch (item.tool) {
    case 'pen':
      return `<path d="${strokePathData(item.points)}" ${common} fill="none"/>`;
    case 'highlighter':
      return `<path d="${strokePathData(item.points)}" ${common} fill="none" opacity="${HIGHLIGHTER_OPACITY}"/>`;
    case 'line':
      return `<line x1="${num(p0[0])}" y1="${num(p0[1])}" x2="${num(p1[0])}" y2="${num(p1[1])}" ${common}/>`;
    case 'arrow':
      return `<line x1="${num(p0[0])}" y1="${num(p0[1])}" x2="${num(p1[0])}" y2="${num(p1[1])}" ${common}/><path d="${arrowHeadPathData(p0, p1, item.width)}" fill="${color}" stroke="${color}" stroke-width="1" stroke-linejoin="round"/>`;
    case 'rect': {
      const x = Math.min(p0[0], p1[0]);
      const y = Math.min(p0[1], p1[1]);
      const w = Math.abs(p1[0] - p0[0]);
      const h = Math.abs(p1[1] - p0[1]);
      return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" ${common} fill="${item.fill ? color : 'none'}" fill-opacity="${item.fill ? SHAPE_FILL_OPACITY : 0}"/>`;
    }
    case 'ellipse': {
      const cx = (p0[0] + p1[0]) / 2;
      const cy = (p0[1] + p1[1]) / 2;
      const rx = Math.abs(p1[0] - p0[0]) / 2;
      const ry = Math.abs(p1[1] - p0[1]) / 2;
      return `<ellipse cx="${num(cx)}" cy="${num(cy)}" rx="${num(rx)}" ry="${num(ry)}" ${common} fill="${item.fill ? color : 'none'}" fill-opacity="${item.fill ? SHAPE_FILL_OPACITY : 0}"/>`;
    }
    case 'text': {
      const size = item.size ?? DEFAULT_TEXT_SIZE;
      const lines = (item.text ?? '').split('\n');
      const spans = lines.map((line, i) => `<tspan x="${num(p0[0])}" dy="${i === 0 ? 0 : num(size * 1.25)}">${escapeXml(line) || ' '}</tspan>`).join('');
      return `<text x="${num(p0[0])}" y="${num(p0[1])}" font-size="${num(size)}" fill="${color}" font-family="ui-sans-serif, system-ui, sans-serif" xml:space="preserve">${spans}</text>`;
    }
    case 'eraser':
      return '';
  }
}

function backgroundSvg(scene: CanvasScene, idPrefix: string): string {
  const bg = scene.background;
  if (bg.kind === 'blank') return '';
  const id = `${idPrefix}bg`;
  const s = bg.spacing;
  let tile = '';
  if (bg.kind === 'grid') tile = `<path d="M${s} 0 L0 0 L0 ${s}" fill="none" stroke="${bg.color}" stroke-width="1"/>`;
  else if (bg.kind === 'ruled') tile = `<line x1="0" y1="${s - 0.5}" x2="${s}" y2="${s - 0.5}" stroke="${bg.color}" stroke-width="1"/>`;
  else tile = `<circle cx="${s / 2}" cy="${s / 2}" r="1" fill="${bg.color}"/>`;
  return `<defs><pattern id="${id}" width="${s}" height="${s}" patternUnits="userSpaceOnUse">${tile}</pattern></defs><rect x="0" y="0" width="${num(scene.width)}" height="${num(scene.height)}" fill="url(#${id})"/>`;
}

/**
 * Inner SVG markup (no outer <svg>) for a scene. The caller supplies the
 * viewBox; `idPrefix` keeps mask ids unique when several drawings share a page.
 */
export function canvasSceneSvgInner(scene: CanvasScene, idPrefix = 'c', inkColor?: string): string {
  let out = backgroundSvg(scene, idPrefix);
  scene.segments.forEach((seg, i) => {
    const body = seg.items.map((it) => canvasItemSvg(it, inkColor)).join('');
    if (!seg.erasers.length) {
      out += `<g>${body}</g>`;
      return;
    }
    const maskId = `${idPrefix}m${i}`;
    const holes = seg.erasers.map((e) => `<path d="${strokePathData(e.points)}" stroke="#000" stroke-width="${num(e.width)}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
    out += `<defs><mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="${num(scene.width)}" height="${num(scene.height)}"><rect x="0" y="0" width="${num(scene.width)}" height="${num(scene.height)}" fill="#fff"/>${holes}</mask></defs><g mask="url(#${maskId})">${body}</g>`;
  });
  return out;
}

/** A complete standalone SVG document for one drawing (server PDF, exports). */
export function canvasToSvg(content: CanvasContentWire, opts: { idPrefix?: string; style?: string; label?: string; inkColor?: string } = {}): string {
  const scene = buildCanvasScene(content);
  const style = opts.style ? ` style="${escapeXml(opts.style)}"` : '';
  const label = opts.label ? ` role="img" aria-label="${escapeXml(opts.label)}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(scene.width)} ${num(scene.height)}"${style}${label}>${canvasSceneSvgInner(scene, opts.idPrefix ?? 'c', opts.inkColor)}</svg>`;
}
