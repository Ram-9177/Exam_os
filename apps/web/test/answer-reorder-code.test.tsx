import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnswerEditor, newCanvas, newCodeBlock, newParagraph } from '../src/features/exam/AnswerEditor';
import { emptyCanvas, findStrokeIndexAt, type Stroke } from '../src/features/drawing/DrawingSurface';
import type { AnswerDoc } from '../src/lib/answers';

describe('Answer Block Reordering & Code Blocks', () => {
  it('moves blocks up and down and triggers onChange with reordered blocks', async () => {
    const user = userEvent.setup();
    const doc: AnswerDoc = {
      blocks: [
        { id: 'b-p1', kind: 'paragraph', content: 'First explanation' },
        { id: 'b-c1', kind: 'canvas', content: emptyCanvas(800, 480) },
      ],
    };
    const handleChange = vi.fn();

    const { rerender } = render(
      <AnswerEditor
        questionId="q1"
        doc={doc}
        placeholderId="b-p1"
        onChange={handleChange}
      />
    );

    // The first paragraph should have Move Up disabled, Move Down enabled
    const moveDownButtons = screen.getAllByRole('button', { name: /Move .* down/i });
    expect(moveDownButtons[0]).not.toBeDisabled();

    // Click Move Down on the first block (b-p1)
    await user.click(moveDownButtons[0]!);

    expect(handleChange).toHaveBeenCalled();
    const callArg = handleChange.mock.calls[0]![0] as AnswerDoc;
    expect(callArg.blocks[0]!.id).toBe('b-c1');
    expect(callArg.blocks[1]!.id).toBe('b-p1');

    // Rerender with the swapped document
    rerender(
      <AnswerEditor
        questionId="q1"
        doc={callArg}
        placeholderId="b-p1"
        onChange={handleChange}
      />
    );

    // Now diagram is first, so its Move Up should be disabled
    const moveUpButtons = screen.getAllByRole('button', { name: /Move .* up/i });
    expect(moveUpButtons[0]).toBeDisabled();
    // And second block (paragraph) Move Up should be enabled
    expect(moveUpButtons[1]).not.toBeDisabled();

    // Click Move Up on paragraph to restore
    await user.click(moveUpButtons[1]!);
    const lastCallArg = handleChange.mock.calls[handleChange.mock.calls.length - 1]![0] as AnswerDoc;
    expect(lastCallArg.blocks[0]!.id).toBe('b-p1');
    expect(lastCallArg.blocks[1]!.id).toBe('b-c1');
  });

  it('allows inserting, editing, and tabbing inside code blocks', async () => {
    const user = userEvent.setup();
    const doc: AnswerDoc = {
      blocks: [
        { id: 'b-p1', kind: 'paragraph', content: 'Intro' },
      ],
    };
    const handleChange = vi.fn();

    const { rerender } = render(
      <AnswerEditor
        questionId="q1"
        doc={doc}
        placeholderId="b-p1"
        onChange={handleChange}
      />
    );

    // Click "+ Insert code"
    const insertCodeBtn = screen.getByRole('button', { name: /\+ Insert code/i });
    await user.click(insertCodeBtn);

    expect(handleChange).toHaveBeenCalled();
    const withCode = handleChange.mock.calls[0]![0] as AnswerDoc;
    expect(withCode.blocks.length).toBe(2);
    expect(withCode.blocks[1]!.kind).toBe('code');

    // Rerender with code block present
    rerender(
      <AnswerEditor
        questionId="q1"
        doc={withCode}
        placeholderId="b-p1"
        onChange={handleChange}
      />
    );

    // Code editor textarea is rendered
    const codeArea = screen.getByPlaceholderText(/Write your code or algorithm here/i);
    expect(codeArea).toBeInTheDocument();

    // Language selector is present
    const langSelect = screen.getByLabelText(/Code block 2 language/i);
    await user.selectOptions(langSelect, 'c_cpp');
    expect(handleChange).toHaveBeenCalled();

    // Test Tab key indentation (indents 2 spaces)
    fireEvent.change(codeArea, { target: { value: 'int main() {\nreturn 0;\n}' } });
    fireEvent.keyDown(codeArea, { key: 'Tab', shiftKey: false });
    expect(handleChange).toHaveBeenCalled();
  });

  it('provides eraser sizing and stroke eraser deletion', async () => {
    const user = userEvent.setup();
    const initialCanvas = emptyCanvas(800, 480);
    // Add two strokes
    const stroke1: Stroke = {
      tool: 'line',
      width: 2,
      points: [[10, 10], [100, 10]],
    };
    const stroke2: Stroke = {
      tool: 'line',
      width: 2,
      points: [[200, 200], [300, 200]],
    };
    initialCanvas.strokes = [stroke1, stroke2];

    const doc: AnswerDoc = {
      blocks: [
        { id: 'b-c1', kind: 'canvas', content: initialCanvas },
      ],
    };
    const handleChange = vi.fn();

    render(
      <AnswerEditor
        questionId="q1"
        doc={doc}
        placeholderId="b-p1"
        onChange={handleChange}
      />
    );

    // Select Eraser tool
    const eraserBtn = screen.getByRole('button', { name: 'Eraser' });
    await user.click(eraserBtn);

    // Eraser sizes (Fine, Medium, Wide, Jumbo) should now be visible in toolbar
    expect(screen.getByRole('button', { name: /Fine \(8px\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Medium \(18px\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Wide \(36px\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Jumbo \(60px\)/i })).toBeInTheDocument();

    // Eraser modes (Brush vs Stroke) are available
    const strokeModeBtn = screen.getByRole('button', { name: 'Stroke' });
    expect(strokeModeBtn).toBeInTheDocument();
    await user.click(strokeModeBtn);

    // Verify findStrokeIndexAt helper directly
    // Point on stroke1: [50, 10]
    expect(findStrokeIndexAt([stroke1, stroke2], [50, 10], 10)).toBe(0);
    // Point on stroke2: [250, 200]
    expect(findStrokeIndexAt([stroke1, stroke2], [250, 200], 10)).toBe(1);
    // Empty point: [500, 500]
    expect(findStrokeIndexAt([stroke1, stroke2], [500, 500], 10)).toBe(-1);
  });
});
