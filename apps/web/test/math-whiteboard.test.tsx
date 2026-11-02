import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Stroke, StrokePoint, AnswerDoc } from '@/lib/answers';
import { emptyCanvas, insertDigitalSymbolOnCanvas } from '@/features/drawing/DrawingSurface';
import { MATH_CATEGORIES, COMMON_FORMULAS } from '@/features/drawing/mathSymbols';
import { extractStrokeFeatures, recognizeMathSymbol } from '@/features/drawing/strokeRecognition';
import { createDigitalItemFromRecognition } from '@/features/drawing/DrawingSurface';
import { MathPalette } from '@/features/drawing/MathPalette';
import { AnswerEditor, normaliseDoc } from '@/features/exam/AnswerEditor';

describe('Math Formulas & Symbols data', () => {
  it('covers essential university mathematics categories and symbols', () => {
    const categoryIds = MATH_CATEGORIES.map((c) => c.id);
    expect(categoryIds).toContain('basic');
    expect(categoryIds).toContain('calculus');
    expect(categoryIds).toContain('greek_lower');
    expect(categoryIds).toContain('greek_upper');
    expect(categoryIds).toContain('algebra');
    expect(categoryIds).toContain('trig');
    expect(categoryIds).toContain('sets_logic');
    expect(categoryIds).toContain('geometry_vectors');

    const calculus = MATH_CATEGORIES.find((c) => c.id === 'calculus')!;
    const calculusSymbols = calculus.items.map((i) => i.symbol);
    expect(calculusSymbols).toContain('∫');
    expect(calculusSymbols).toContain('∑');
    expect(calculusSymbols).toContain('∂');
    expect(calculusSymbols).toContain('d/dx');
    expect(calculusSymbols).toContain('lim');

    const greek = MATH_CATEGORIES.find((c) => c.id === 'greek_lower')!;
    const greekSymbols = greek.items.map((i) => i.symbol);
    expect(greekSymbols).toContain('α');
    expect(greekSymbols).toContain('π');
    expect(greekSymbols).toContain('θ');
  });

  it('includes standard university exam formulas', () => {
    expect(COMMON_FORMULAS.length).toBeGreaterThanOrEqual(10);
    const titles = COMMON_FORMULAS.map((f) => f.title);
    expect(titles).toContain('Quadratic Formula');
    expect(titles).toContain('Pythagorean Theorem');
    expect(titles).toContain('Fundamental Theorem of Calculus');
    expect(titles).toContain('Taylor Series Expansion');
  });
});

describe('Stroke and Shape Recognition Engine', () => {
  it('recognizes a drawn square root (√) stroke', () => {
    // Generate simulated hand-drawn square root:
    // Starts mid-left, dips down to sharp bottom vertex, rises to top-right, extends horizontally right
    const points: StrokePoint[] = [
      [50, 70],
      [52, 75],
      [55, 85],
      [60, 100], // bottom vertex (lowest Y = 100)
      [65, 80],
      [70, 55],
      [75, 30],
      [80, 20], // top vertex (highest Y = 20)
      [90, 20],
      [105, 20],
      [120, 20], // horizontal overbar
    ];

    const stroke: Stroke = { tool: 'pen', width: 2.5, color: 'ink', points };
    const recognized = recognizeMathSymbol(stroke);

    expect(recognized).not.toBeNull();
    expect(recognized!.symbol).toBe('√');
    expect(recognized!.name).toBe('Square Root');
    expect(recognized!.confidence).toBeGreaterThanOrEqual(0.7);

    // Verify digital item creation
    const digitalItem = createDigitalItemFromRecognition(recognized!, stroke, 24);
    expect(digitalItem.tool).toBe('text');
    expect(digitalItem.text).toBe('√');
    expect(digitalItem.points[0]![0]).toBe(50);
  });

  it('recognizes a tall hand-drawn integral (∫) stroke', () => {
    // S-curve: starts top right, curves left, straight vertical down, curves right at bottom
    const points: StrokePoint[] = [
      [65, 25],
      [58, 22],
      [50, 26],
      [48, 35],
      [50, 60],
      [50, 90],
      [50, 120],
      [52, 140],
      [58, 146],
      [66, 144],
    ];

    const stroke: Stroke = { tool: 'pen', width: 2.5, color: 'blue', points };
    const recognized = recognizeMathSymbol(stroke);

    expect(recognized).not.toBeNull();
    expect(recognized!.symbol).toBe('∫');
    expect(recognized!.name).toBe('Integral');

    const digital = createDigitalItemFromRecognition(recognized!, stroke);
    expect(digital.tool).toBe('text');
    expect(digital.text).toBe('∫');
    expect(digital.color).toBe('blue');
  });

  it('recognizes an infinity (∞) figure-8 stroke', () => {
    // Wide horizontal figure 8
    const points: StrokePoint[] = [
      [100, 50],
      [115, 35],
      [130, 50],
      [115, 65],
      [100, 50], // center crossing
      [85, 35],
      [70, 50],
      [85, 65],
      [100, 50], // loop closed
    ];

    const stroke: Stroke = { tool: 'pen', width: 2.5, color: 'ink', points };
    const recognized = recognizeMathSymbol(stroke);

    expect(recognized).not.toBeNull();
    expect(recognized!.symbol).toBe('∞');
    expect(recognized!.name).toBe('Infinity');
  });

  it('recognizes hand-drawn geometric shapes and substitutes vector tools', () => {
    // Hand-drawn rectangle (closed 4 corners)
    const rectPoints: StrokePoint[] = [
      [50, 50],
      [150, 50],
      [150, 120],
      [50, 120],
      [50, 50],
    ];
    const rectStroke: Stroke = { tool: 'pen', width: 2.5, color: 'ink', points: rectPoints };
    const rectRec = recognizeMathSymbol(rectStroke);
    expect(rectRec).not.toBeNull();
    expect(rectRec!.tool).toBe('rect');

    const digitalRect = createDigitalItemFromRecognition(rectRec!, rectStroke);
    expect(digitalRect.tool).toBe('rect');
    expect(digitalRect.points).toEqual([
      [50, 50],
      [150, 120],
    ]);
  });
});

describe('MathPalette Component', () => {
  it('renders categories and allows inserting symbols into whiteboard', () => {
    const onInsertToCanvas = vi.fn();
    const onInsertToParagraph = vi.fn();

    render(
      <MathPalette
        onInsertToCanvas={onInsertToCanvas}
        onInsertToParagraph={onInsertToParagraph}
      />
    );

    // Check title
    expect(screen.getByText('Math Formulas & Symbols')).toBeDefined();

    // Click Calculus tab
    const calculusTab = screen.getByRole('tab', { name: /calculus/i });
    fireEvent.click(calculusTab);

    // Find and click integral symbol '∫'
    const integralBtn = screen.getByTitle(/integral \(∫\)/i);
    fireEvent.click(integralBtn);

    expect(onInsertToCanvas).toHaveBeenCalledWith('∫');
  });

  it('filters symbols and standard formulas by search query', () => {
    const onInsertToCanvas = vi.fn();
    render(<MathPalette onInsertToCanvas={onInsertToCanvas} />);

    const searchInput = screen.getByRole('searchbox');
    fireEvent.change(searchInput, { target: { value: 'quadratic' } });

    // Should find Quadratic Formula
    expect(screen.getByText('Quadratic Formula')).toBeDefined();
    expect(screen.getByText(/x = \(-b ± √\(b² - 4ac\)\) \/ \(2a\)/i)).toBeDefined();

    const placeBtn = screen.getByTitle('Place formula onto the whiteboard');
    fireEvent.click(placeBtn);
    expect(onInsertToCanvas).toHaveBeenCalledWith('x = (-b ± √(b² - 4ac)) / (2a)');
  });
});

describe('AnswerEditor Whiteboard Math Integration', () => {
  it('toggles Math Palette in Diagram block and places digital math onto canvas', () => {
    const canvas = emptyCanvas(800, 480);
    const doc: AnswerDoc = {
      blocks: [
        { id: 'b1', kind: 'paragraph', content: 'Here is my solution:' },
        { id: 'b2', kind: 'canvas', content: canvas },
      ],
    };

    const onChange = vi.fn();
    render(
      <AnswerEditor
        questionId="q1"
        doc={doc}
        placeholderId="p1"
        onChange={onChange}
      />
    );

    // Find "∑ fx Math" button
    const mathBtn = screen.getByRole('button', { name: /∑ fx math/i });
    expect(mathBtn).toBeDefined();

    // Click to open math palette
    fireEvent.click(mathBtn);
    expect(screen.getByText('Math Formulas & Symbols')).toBeDefined();

    // Insert a plus symbol
    const plusBtn = screen.getByTitle(/plus \(\+\)/i);
    fireEvent.click(plusBtn);

    expect(onChange).toHaveBeenCalled();
    const updatedDoc = onChange.mock.calls[0]![0];
    const canvasBlock = updatedDoc.blocks.find((b: any) => b.kind === 'canvas')!;
    expect(canvasBlock.content.strokes.length).toBe(1);
    expect(canvasBlock.content.strokes[0].tool).toBe('text');
    expect(canvasBlock.content.strokes[0].text).toBe('+');
  });

  it('toggles Auto-convert mode in the whiteboard toolbar', () => {
    const canvas = emptyCanvas(800, 480);
    const doc: AnswerDoc = {
      blocks: [
        { id: 'b2', kind: 'canvas', content: canvas },
      ],
    };

    render(
      <AnswerEditor
        questionId="q1"
        doc={doc}
        placeholderId="p1"
        onChange={vi.fn()}
      />
    );

    const autoConvertBtn = screen.getByRole('button', { name: /auto-convert: off/i });
    expect(autoConvertBtn).toBeDefined();

    fireEvent.click(autoConvertBtn);
    expect(screen.getByRole('button', { name: /auto-convert: on/i })).toBeDefined();
  });
});
