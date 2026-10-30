import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buildCanvasScene, canvasToSvg } from '@examos/contracts';
import type { AnswerDoc, CanvasContent } from '@/lib/answers';
import { DrawingSurface, emptyCanvas } from '@/features/drawing/DrawingSurface';
import { StrokesSvg } from '@/features/drawing/StrokesSvg';
import { AnswerEditor } from '@/features/exam/AnswerEditor';

const full: CanvasContent = {
  width: 400,
  height: 300,
  background: 'grid',
  strokes: [
    { tool: 'pen', width: 2, points: [[10, 10], [50, 40], [90, 20]] },
    { tool: 'eraser', width: 12, points: [[45, 35], [55, 45]] },
    { tool: 'highlighter', width: 14, color: 'orange', points: [[10, 80], [200, 80]] },
    { tool: 'line', width: 2, color: 'blue', points: [[10, 100], [100, 100]] },
    { tool: 'arrow', width: 2, color: 'red', points: [[10, 120], [100, 150]] },
    { tool: 'rect', width: 2, color: 'green', fill: true, points: [[120, 100], [200, 160]] },
    { tool: 'ellipse', width: 2, color: 'purple', points: [[220, 100], [300, 160]] },
    { tool: 'text', width: 1, points: [[20, 220]], text: 'Router <b>A</b>\nline 2', size: 18 },
  ],
};

describe('whiteboard rendering (shared with the server PDF)', () => {
  it('groups items so an eraser only removes what was drawn before it', () => {
    const scene = buildCanvasScene(full);
    expect(scene.visibleCount).toBe(7);
    expect(scene.segments).toHaveLength(2);
    expect(scene.segments[0]!.items.map((i) => i.tool)).toEqual(['pen']);
    expect(scene.segments[0]!.erasers).toHaveLength(1);
    expect(scene.segments[1]!.items).toHaveLength(6);
    expect(scene.segments[1]!.erasers).toHaveLength(0);
    expect(scene.background).toMatchObject({ kind: 'grid', spacing: 20 });
  });

  it('emits every tool as a vector primitive with its colour, fill, arrow head, escaped text and paper', () => {
    const svg = canvasToSvg(full, { idPrefix: 't' });
    expect(svg).toContain('<mask id="tm0"');
    expect(svg).toContain('opacity="0.35"');
    expect(svg).toContain('<line x1="10" y1="100" x2="100" y2="100" stroke="#1d4ed8"');
    expect(svg).toMatch(/<path d="M100 150 L[\d.]+ [\d.]+ L[\d.]+ [\d.]+ Z" fill="#b91c1c"/);
    expect(svg).toContain('<rect x="120" y="100" width="80" height="60" stroke="#15803d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="#15803d" fill-opacity="0.15"');
    expect(svg).toContain('<ellipse cx="260" cy="130" rx="40" ry="30" stroke="#7e22ce"');
    expect(svg).toContain('Router &lt;b&gt;A&lt;/b&gt;');
    expect(svg).toContain('<tspan x="20" dy="22.5">line 2</tspan>');
    expect(svg).toContain('<pattern id="tbg" width="20" height="20"');
    expect(svg).not.toContain('<b>');
  });

  it('StrokesSvg announces the visible item count and draws with the page ink', () => {
    const { container } = render(<StrokesSvg content={full} label="Diagram 3" />);
    const svg = screen.getByRole('img', { name: 'Diagram 3, 7 strokes' });
    expect(svg.getAttribute('viewBox')).toBe('0 0 400 300');
    expect(container.querySelectorAll('ellipse')).toHaveLength(1);
    expect(container.querySelectorAll('rect').length).toBeGreaterThanOrEqual(2); // paper + shape + mask backdrop
    expect(container.querySelector('path[stroke="currentColor"]')).not.toBeNull();
  });
});

function Surface(props: { tool: Parameters<typeof DrawingSurface>[0]['tool']; color?: 'ink' | 'red'; fill?: boolean; onChange: (c: CanvasContent) => void }) {
  const [value, setValue] = useState<CanvasContent>(() => emptyCanvas(400, 300));
  return (
    <DrawingSurface
      value={value}
      onChange={(next) => {
        setValue(next);
        props.onChange(next);
      }}
      tool={props.tool}
      color={props.color}
      fill={props.fill}
      label="Diagram 1"
    />
  );
}

const pointer = (el: Element, type: 'pointerDown' | 'pointerMove' | 'pointerUp', x: number, y: number) => fireEvent[type](el, { clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse' });

describe('DrawingSurface tools', () => {
  it('records a freehand pen stroke as points and an eraser as an eraser item without colour', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Surface tool="pen" color="red" onChange={onChange} />);
    const canvas = screen.getByRole('img', { name: 'Diagram 1. 0 items.' });
    pointer(canvas, 'pointerDown', 10, 10);
    pointer(canvas, 'pointerMove', 30, 30);
    pointer(canvas, 'pointerMove', 60, 45);
    pointer(canvas, 'pointerUp', 60, 45);
    expect(onChange).toHaveBeenCalledTimes(1);
    const pen = onChange.mock.calls[0]![0].strokes[0];
    expect(pen).toMatchObject({ tool: 'pen', color: 'red' });
    expect(pen.points).toEqual([[10, 10], [30, 30], [60, 45]]);
    expect(screen.getByRole('img', { name: 'Diagram 1. 1 item.' })).toBeInTheDocument();

    rerender(<Surface tool="eraser" color="red" onChange={onChange} />);
    const again = screen.getByRole('img', { name: /Diagram 1\./ });
    pointer(again, 'pointerDown', 20, 20);
    pointer(again, 'pointerMove', 40, 40);
    pointer(again, 'pointerUp', 40, 40);
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]![0].strokes.at(-1);
    expect(last.tool).toBe('eraser');
    expect(last.color).toBeUndefined();
    expect(last.width).toBe(18);
  });

  it('draws shapes from two corners, honours fill, and ignores a click that is not a drag', () => {
    const onChange = vi.fn();
    render(<Surface tool="rect" fill onChange={onChange} />);
    const canvas = screen.getByRole('img', { name: /Diagram 1\./ });
    pointer(canvas, 'pointerDown', 50, 50);
    pointer(canvas, 'pointerUp', 50, 50);
    expect(onChange).not.toHaveBeenCalled();
    pointer(canvas, 'pointerDown', 50, 50);
    pointer(canvas, 'pointerMove', 120, 90);
    pointer(canvas, 'pointerMove', 150, 110);
    pointer(canvas, 'pointerUp', 150, 110);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].strokes[0]).toEqual({ tool: 'rect', width: 2.25, color: 'ink', fill: true, points: [[50, 50], [150, 110]] });
  });

  it('places typed text at the clicked point; Escape cancels, Enter commits', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Surface tool="text" onChange={onChange} />);
    const canvas = screen.getByRole('img', { name: /Diagram 1\./ });
    // In a real browser the mousedown that follows pointerdown would move focus off the text box the tool just
    // opened (it would close empty). The canvas cancels it; jsdom has no focus default action, so assert the cancel.
    expect(fireEvent.mouseDown(canvas, { button: 0 })).toBe(false);
    pointer(canvas, 'pointerDown', 30, 40);
    const box = await screen.findByLabelText('Text to place on the diagram');
    await user.type(box, 'draft');
    await user.keyboard('{Escape}');
    expect(screen.queryByLabelText('Text to place on the diagram')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    pointer(canvas, 'pointerDown', 30, 40);
    const box2 = await screen.findByLabelText('Text to place on the diagram');
    await user.type(box2, 'Node A{Enter}');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].strokes[0]).toMatchObject({ tool: 'text', text: 'Node A', points: [[30, 40]], size: 18 });
  });
});

function Editor({ initial, onChange }: { initial: AnswerDoc; onChange: (d: AnswerDoc) => void }) {
  const [doc, setDoc] = useState(initial);
  return (
    <AnswerEditor
      questionId="Q1"
      doc={doc}
      placeholderId="ph"
      onChange={(d) => {
        setDoc(d);
        onChange(d);
      }}
    />
  );
}

describe('diagram toolbar', () => {
  const canvasDoc = (): AnswerDoc => ({ blocks: [{ id: 'p', kind: 'paragraph', content: 'see diagram' }, { id: 'c', kind: 'canvas', content: { width: 800, height: 480, strokes: [{ tool: 'pen', width: 2, points: [[1, 1], [5, 5]] }] } }] });
  const strokesOf = (d: AnswerDoc) => (d.blocks[1]!.content as CanvasContent).strokes;

  it('offers every tool, colour, width, paper and undo/redo/clear/taller', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(d: AnswerDoc) => void>();
    render(<Editor initial={canvasDoc()} onChange={onChange} />);
    const toolbar = screen.getByRole('toolbar', { name: 'Diagram 2 tools' });
    for (const name of ['Pen', 'Highlighter', 'Eraser', 'Line', 'Arrow', 'Rectangle', 'Ellipse', 'Text']) expect(within(toolbar).getByRole('button', { name })).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: 'Pen' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(within(toolbar).getByRole('button', { name: 'Ellipse' }));
    expect(screen.getByRole('button', { name: 'Fill' })).toHaveAttribute('aria-pressed', 'false');
    await user.click(screen.getByRole('button', { name: 'Red colour' }));
    expect(screen.getByRole('button', { name: 'Red colour' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(toolbar).getByRole('button', { name: 'Text' }));
    expect(screen.getByRole('group', { name: 'Diagram 2 text size' })).toBeInTheDocument();
    await user.click(within(toolbar).getByRole('button', { name: 'Eraser' }));
    expect(screen.getByRole('button', { name: 'Red colour' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(strokesOf(onChange.mock.calls.at(-1)![0])).toEqual([]);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Redo' }));
    expect(strokesOf(onChange.mock.calls.at(-1)![0])).toHaveLength(1);

    await user.selectOptions(screen.getByLabelText('Diagram 2 paper'), 'ruled');
    expect((onChange.mock.calls.at(-1)![0].blocks[1]!.content as CanvasContent).background).toBe('ruled');
    await user.selectOptions(screen.getByLabelText('Diagram 2 paper'), 'blank');
    expect('background' in (onChange.mock.calls.at(-1)![0].blocks[1]!.content as CanvasContent)).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Taller' }));
    expect((onChange.mock.calls.at(-1)![0].blocks[1]!.content as CanvasContent).height).toBe(720);

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await user.click(screen.getByRole('button', { name: 'Clear everything' }));
    expect(strokesOf(onChange.mock.calls.at(-1)![0])).toEqual([]);
    expect(screen.getByText('0 items')).toBeInTheDocument();
  });
});
