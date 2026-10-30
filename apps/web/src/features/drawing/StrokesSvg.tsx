import { useId } from 'react';
import { buildCanvasScene, canvasSceneSvgInner } from '@examos/contracts';
import type { CanvasContent } from '@/lib/answers';

/**
 * Vector re-render of a whiteboard block for the booklet, the evaluator and
 * print. It is the same scene builder the server uses for the PDF, so every
 * reader sees exactly what the student drew: colours, shapes, text, the
 * background and erasers that only remove what came before them. Ink follows
 * the page colour so the drawing stays legible in dark mode.
 */
export function StrokesSvg({ content, className, label = 'Diagram' }: { content: CanvasContent; className?: string; label?: string }) {
  const prefix = useId().replace(/[^a-zA-Z0-9]/g, '');
  const scene = buildCanvasScene(content);
  return (
    <svg
      viewBox={`0 0 ${scene.width} ${scene.height}`}
      role="img"
      aria-label={`${label}, ${scene.visibleCount} ${scene.visibleCount === 1 ? 'stroke' : 'strokes'}`}
      className={className}
      style={{ width: '100%', height: 'auto', display: 'block' }}
      dangerouslySetInnerHTML={{ __html: canvasSceneSvgInner(scene, prefix, 'currentColor') }}
    />
  );
}
