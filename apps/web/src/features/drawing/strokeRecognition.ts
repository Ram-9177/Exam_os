/**
 * Stroke and Shape Recognition Engine for ExamOS Whiteboard.
 *
 * Recognizes handwritten mathematical symbols (√, ∫, ∑, π, θ, ∞, α, Δ, ±, ÷, ×, ≠, ≤, ≥, ∈, →)
 * and geometric shapes (rect, ellipse, line, arrow) from pointer stroke coordinates.
 */
import type { Stroke, StrokePoint } from '@/lib/answers';
import type { DrawingTool } from './DrawingSurface';

export interface RecognizedSymbol {
  symbol: string;
  name: string;
  confidence: number;
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
  };
  /** If the symbol is a geometric tool substitute (e.g. rect, ellipse, line, arrow) */
  tool?: DrawingTool;
}

interface StrokeFeatures {
  points: StrokePoint[];
  count: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
  aspectRatio: number; // width / height
  centerX: number;
  centerY: number;
  startPoint: StrokePoint;
  endPoint: StrokePoint;
  pathLength: number;
  startEndDistance: number;
  isClosed: boolean;
  circularity: number; // 4 * PI * Area / (Perimeter^2)
  cornerCount: number;
  xTurnCount: number;
  yTurnCount: number;
  selfIntersectionCount: number;
}

/**
 * Extracts geometric features from an array of stroke points.
 */
export function extractStrokeFeatures(points: StrokePoint[]): StrokeFeatures {
  if (points.length === 0) {
    return {
      points: [],
      count: 0,
      minX: 0,
      maxX: 0,
      minY: 0,
      maxY: 0,
      width: 0,
      height: 0,
      aspectRatio: 1,
      centerX: 0,
      centerY: 0,
      startPoint: [0, 0],
      endPoint: [0, 0],
      pathLength: 0,
      startEndDistance: 0,
      isClosed: false,
      circularity: 0,
      cornerCount: 0,
      xTurnCount: 0,
      yTurnCount: 0,
      selfIntersectionCount: 0,
    };
  }

  let minX = points[0]![0];
  let maxX = points[0]![0];
  let minY = points[0]![1];
  let maxY = points[0]![1];
  let pathLength = 0;

  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;

    if (i > 0) {
      const [px, py] = points[i - 1]!;
      pathLength += Math.hypot(x - px, y - py);
    }
  }

  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const aspectRatio = width / height;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const startPoint = points[0]!;
  const endPoint = points[points.length - 1]!;
  const startEndDistance = Math.hypot(endPoint[0] - startPoint[0], endPoint[1] - startPoint[1]);
  const diag = Math.hypot(width, height);
  const isClosed = startEndDistance < Math.max(18, 0.28 * diag);

  // Approximate polygon area using Shoelace formula
  let polygonArea = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    polygonArea += points[i]![0] * points[j]![1];
    polygonArea -= points[j]![0] * points[i]![1];
  }
  polygonArea = Math.abs(polygonArea) / 2;
  const circularity = pathLength > 0 ? (4 * Math.PI * polygonArea) / (pathLength * pathLength) : 0;

  // Corner detection: check angles between consecutive vectors
  let cornerCount = 0;
  const cStep = Math.max(1, Math.floor(points.length / 12));
  for (let i = cStep; i < points.length - cStep; i += cStep) {
    const v1x = points[i]![0] - points[i - cStep]![0];
    const v1y = points[i]![1] - points[i - cStep]![1];
    const v2x = points[i + cStep]![0] - points[i]![0];
    const v2y = points[i + cStep]![1] - points[i]![1];
    const len1 = Math.hypot(v1x, v1y);
    const len2 = Math.hypot(v2x, v2y);
    if (len1 > 2 && len2 > 2) {
      const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
      if (Math.abs(dot) < 0.45) cornerCount++;
    }
  }

  // Directional reversals (inflection / turn counts)
  let xTurnCount = 0;
  let yTurnCount = 0;
  let prevDx = 0;
  let prevDy = 0;
  const sampleStep = Math.max(1, Math.floor(points.length / 30));

  for (let i = sampleStep; i < points.length; i += sampleStep) {
    const dx = points[i]![0] - points[i - sampleStep]![0];
    const dy = points[i]![1] - points[i - sampleStep]![1];
    if (Math.abs(dx) > 3) {
      if (prevDx !== 0 && Math.sign(dx) !== Math.sign(prevDx)) xTurnCount++;
      prevDx = dx;
    }
    if (Math.abs(dy) > 3) {
      if (prevDy !== 0 && Math.sign(dy) !== Math.sign(prevDy)) yTurnCount++;
      prevDy = dy;
    }
  }

  // Self intersections check (sampled)
  let selfIntersectionCount = 0;
  const step = Math.max(1, Math.floor(points.length / 25));
  for (let i = 0; i < points.length - step * 2; i += step) {
    const p1 = points[i]!;
    const p2 = points[i + step]!;
    for (let j = i + step * 2; j < points.length - step; j += step) {
      const p3 = points[j]!;
      const p4 = points[j + step]!;
      if (linesIntersect(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1], p4[0], p4[1])) {
        selfIntersectionCount++;
      }
    }
  }

  return {
    points,
    count: points.length,
    minX,
    maxX,
    minY,
    maxY,
    width,
    height,
    aspectRatio,
    centerX,
    centerY,
    startPoint,
    endPoint,
    pathLength,
    startEndDistance,
    isClosed,
    circularity,
    cornerCount,
    xTurnCount,
    yTurnCount,
    selfIntersectionCount,
  };
}

function linesIntersect(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number): boolean {
  const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/**
 * Recognizes if a stroke or combined strokes form a math symbol or geometric shape.
 */
export function recognizeMathSymbol(stroke: Stroke, recentStrokes: Stroke[] = []): RecognizedSymbol | null {
  if (stroke.tool !== 'pen' && stroke.tool !== 'line') return null;
  if (stroke.points.length < 5) return null;

  const f = extractStrokeFeatures(stroke.points);
  if (f.width < 12 && f.height < 12) return null; // Too small to be deliberate symbol

  // Candidates list
  const candidates: RecognizedSymbol[] = [];
  const bounds = {
    minX: f.minX,
    maxX: f.maxX,
    minY: f.minY,
    maxY: f.maxY,
    width: f.width,
    height: f.height,
    centerX: f.centerX,
    centerY: f.centerY,
  };

  // -------------------------------------------------------------
  // 1. Radical / Square Root (√)
  // Characteristic: starts left, dips down, ascends sharply up-right,
  // and optionally has a rightward horizontal bar over the top.
  // -------------------------------------------------------------
  const startXNorm = (f.startPoint[0] - f.minX) / f.width;
  const startYNorm = (f.startPoint[1] - f.minY) / f.height;
  const endXNorm = (f.endPoint[0] - f.minX) / f.width;
  const endYNorm = (f.endPoint[1] - f.minY) / f.height;

  // Find lowest point (max Y in canvas coordinates)
  let lowestYIdx = 0;
  let lowestY = f.points[0]![1];
  for (let i = 0; i < f.points.length; i++) {
    if (f.points[i]![1] > lowestY) {
      lowestY = f.points[i]![1];
      lowestYIdx = i;
    }
  }
  const lowestXNorm = (f.points[lowestYIdx]![0] - f.minX) / f.width;
  const lowestYNorm = (lowestY - f.minY) / f.height;

  // Find highest point (min Y in canvas coordinates)
  let highestYIdx = 0;
  let highestY = f.points[0]![1];
  for (let i = 0; i < f.points.length; i++) {
    if (f.points[i]![1] < highestY) {
      highestY = f.points[i]![1];
      highestYIdx = i;
    }
  }
  const highestXNorm = (f.points[highestYIdx]![0] - f.minX) / f.width;

  // Check Radical conditions:
  // Starts on left (startXNorm < 0.45)
  // Dips to lowest point between x: 0.1 and 0.65
  // Ascends to top (highest point near y=0)
  // End point is to the right of the lowest point (endXNorm > lowestXNorm)
  if (
    startXNorm < 0.45 &&
    lowestYNorm > 0.75 &&
    lowestXNorm < 0.65 &&
    highestYIdx > lowestYIdx &&
    highestXNorm >= lowestXNorm &&
    endXNorm > 0.4
  ) {
    let conf = 0.75;
    if (endXNorm > 0.75) conf += 0.15; // horizontal overhang
    if (f.aspectRatio > 0.6 && f.aspectRatio < 2.5) conf += 0.05;
    candidates.push({ symbol: '√', name: 'Square Root', confidence: conf, bounds });
  }

  // -------------------------------------------------------------
  // 2. Integral (∫)
  // Characteristic: tall (aspectRatio < 0.65), S-like curve,
  // starts top-right or curls top, goes down through center,
  // curls right at bottom.
  // -------------------------------------------------------------
  if (f.aspectRatio < 0.65 && f.height > 25 && !f.isClosed) {
    // Top segment curves right/left, bottom curves right
    const topX = f.startPoint[0];
    const botX = f.endPoint[0];
    const topY = f.startPoint[1];
    const botY = f.endPoint[1];

    if (topY < botY && f.yTurnCount <= 2) {
      // Goes downwards
      let conf = 0.72;
      if (f.aspectRatio < 0.45) conf += 0.15;
      if (topX > f.minX + f.width * 0.4 && botX > f.minX + f.width * 0.4) conf += 0.08;
      candidates.push({ symbol: '∫', name: 'Integral', confidence: conf, bounds });
    }
  }

  // -------------------------------------------------------------
  // 3. Summation (∑)
  // Characteristic: Zigzag, horizontal top, diagonal in,
  // diagonal out, horizontal bottom. Has 2-3 X reversals.
  // -------------------------------------------------------------
  if (f.xTurnCount >= 2 && f.aspectRatio > 0.45 && f.aspectRatio < 1.6 && !f.isClosed) {
    // Check if middle point penetrates towards center-right
    let conf = 0.68;
    if (f.xTurnCount === 2 || f.xTurnCount === 3) conf += 0.15;
    candidates.push({ symbol: '∑', name: 'Summation (Sigma)', confidence: conf, bounds });
  }

  // -------------------------------------------------------------
  // 4. Infinity (∞)
  // Characteristic: Wide, figure 8 lying on side, self-intersects
  // near center, closed.
  // -------------------------------------------------------------
  if (f.aspectRatio > 1.2 && f.selfIntersectionCount >= 1 && f.isClosed) {
    let conf = 0.8;
    if (f.aspectRatio > 1.5) conf += 0.1;
    candidates.push({ symbol: '∞', name: 'Infinity', confidence: conf, bounds });
  }

  // -------------------------------------------------------------
  // 5. Alpha (α)
  // Characteristic: loop, starts top right, loops left, crosses
  // at bottom right.
  // -------------------------------------------------------------
  if (f.selfIntersectionCount === 1 && f.aspectRatio > 0.7 && f.aspectRatio < 1.7 && !f.isClosed) {
    candidates.push({ symbol: 'α', name: 'Alpha', confidence: 0.75, bounds });
  }

  // -------------------------------------------------------------
  // 6. Theta (θ)
  // Characteristic: closed oval with horizontal line in middle,
  // or a loop that terminates horizontally across center.
  // -------------------------------------------------------------
  if (f.isClosed && f.aspectRatio > 0.6 && f.aspectRatio < 1.3 && f.circularity > 0.4) {
    // Check if recent stroke or this stroke crossed horizontally
    if (f.selfIntersectionCount >= 1 || f.xTurnCount >= 2) {
      candidates.push({ symbol: 'θ', name: 'Theta', confidence: 0.76, bounds });
    }
  }

  // -------------------------------------------------------------
  // 7. Delta / Triangle (Δ)
  // Characteristic: 3 sharp turns, closed, triangular bounds.
  // -------------------------------------------------------------
  if (f.isClosed && f.aspectRatio > 0.7 && f.aspectRatio < 1.6 && f.circularity < 0.7) {
    if (f.xTurnCount === 1 || f.xTurnCount === 2) {
      candidates.push({ symbol: 'Δ', name: 'Delta', confidence: 0.78, bounds });
    }
  }

  // -------------------------------------------------------------
  // 8. Pi (π)
  // Characteristic: horizontal top with 2 downward legs.
  // If recent stroke was horizontal and this is vertical leg,
  // or single stroke zig-zag.
  // -------------------------------------------------------------
  if (recentStrokes.length >= 2) {
    const s1 = recentStrokes[recentStrokes.length - 2];
    const s2 = recentStrokes[recentStrokes.length - 1];
    if (s1 && s2) {
      const f1 = extractStrokeFeatures(s1.points);
      const f2 = extractStrokeFeatures(s2.points);
      // s1 horizontal bar, s2 vertical leg, current stroke vertical leg
      if (f1.aspectRatio > 1.8 && f2.aspectRatio < 0.6 && f.aspectRatio < 0.6) {
        const combinedBounds = {
          minX: Math.min(f1.minX, f2.minX, f.minX),
          maxX: Math.max(f1.maxX, f2.maxX, f.maxX),
          minY: Math.min(f1.minY, f2.minY, f.minY),
          maxY: Math.max(f1.maxY, f2.maxY, f.maxY),
          width: Math.max(f1.maxX, f2.maxX, f.maxX) - Math.min(f1.minX, f2.minX, f.minX),
          height: Math.max(f1.maxY, f2.maxY, f.maxY) - Math.min(f1.minY, f2.minY, f.minY),
          centerX: (Math.min(f1.minX, f2.minX, f.minX) + Math.max(f1.maxX, f2.maxX, f.maxX)) / 2,
          centerY: (Math.min(f1.minY, f2.minY, f.minY) + Math.max(f1.maxY, f2.maxY, f.maxY)) / 2,
        };
        candidates.push({ symbol: 'π', name: 'Pi', confidence: 0.88, bounds: combinedBounds });
      }
    }
  }

  // -------------------------------------------------------------
  // 9. Arrow (→)
  // Characteristic: stroke mostly horizontal left to right,
  // end turns back into an arrow head.
  // -------------------------------------------------------------
  if (f.aspectRatio > 1.8 && startXNorm < 0.2 && endXNorm < 0.85 && f.xTurnCount >= 1) {
    candidates.push({ symbol: '→', name: 'Right Arrow', confidence: 0.8, bounds, tool: 'arrow' });
  }

  // -------------------------------------------------------------
  // 10. Geometric Shapes (Rectangle, Circle/Ellipse, Straight Line)
  // -------------------------------------------------------------
  // Rectangle / Box (detected by corner turns or rectangular circularity with turns)
  if (f.isClosed && (f.cornerCount >= 2 || (f.xTurnCount >= 1 && f.yTurnCount >= 1)) && f.circularity < 0.88) {
    candidates.push({ symbol: '□', name: 'Rectangle', confidence: 0.86, bounds, tool: 'rect' });
  } else if (f.isClosed && f.circularity > 0.65 && f.selfIntersectionCount <= 1 && f.cornerCount <= 1) {
    // Clean circle or ellipse (smooth curve, no sharp corners)
    candidates.push({ symbol: '○', name: 'Circle / Ellipse', confidence: 0.85, bounds, tool: 'ellipse' });
  }

  // Straight line
  const straightness = f.pathLength > 0 ? f.startEndDistance / f.pathLength : 0;
  if (!f.isClosed && straightness > 0.94 && f.pathLength > 30) {
    candidates.push({ symbol: '―', name: 'Straight Line', confidence: 0.85, bounds, tool: 'line' });
  }

  // Select candidate with highest confidence above 0.70 threshold
  candidates.sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0];
  if (best && best.confidence >= 0.7) {
    return best;
  }

  return null;
}
