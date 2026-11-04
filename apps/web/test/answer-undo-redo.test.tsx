import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AnswerEditor } from '@/features/exam/AnswerEditor';
import type { AnswerDoc } from '@/lib/answers';

describe('AnswerEditor and Diagram Keyboard Undo/Redo', () => {
  it('triggers stroke undo on Ctrl+Z and redo on Ctrl+Y when diagram is active', () => {
    let currentDoc: AnswerDoc = {
      blocks: [
        { id: 'p1', kind: 'paragraph', content: 'Answer text' },
        {
          id: 'c1',
          kind: 'canvas',
          content: {
            width: 800,
            height: 480,
            strokes: [
              { tool: 'pen', width: 2.5, points: [[10, 10], [20, 20]], color: 'ink' },
              { tool: 'pen', width: 2.5, points: [[30, 30], [40, 40]], color: 'ink' },
            ],
          },
        },
      ],
    };

    const handleChange = vi.fn((next: AnswerDoc) => {
      currentDoc = next;
    });

    const { rerender } = render(
      <AnswerEditor
        questionId="Q1"
        doc={currentDoc}
        placeholderId="ph-1"
        onChange={handleChange}
      />
    );

    // Initial items count is 2
    expect(screen.getByText('2 items')).toBeDefined();

    // Focus the diagram figure/canvas
    const figure = screen.getByRole('figure');
    figure.focus();
    fireEvent.mouseEnter(figure);

    // Press Ctrl+Z
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });

    // Should have called onChange with 1 stroke
    expect(handleChange).toHaveBeenCalled();
    const updatedCanvas = currentDoc.blocks[1]?.content as any;
    expect(updatedCanvas.strokes.length).toBe(1);

    // Rerender with updated doc
    rerender(
      <AnswerEditor
        questionId="Q1"
        doc={currentDoc}
        placeholderId="ph-1"
        onChange={handleChange}
      />
    );

    // Press Ctrl+Y (Redo)
    fireEvent.keyDown(window, { key: 'y', ctrlKey: true });

    // Should have restored to 2 strokes
    const redoneCanvas = currentDoc.blocks[1]?.content as any;
    expect(redoneCanvas.strokes.length).toBe(2);
  });

  it('triggers block undo on Ctrl+Z when inserting and undoing a diagram', () => {
    let currentDoc: AnswerDoc = {
      blocks: [{ id: 'p1', kind: 'paragraph', content: 'Initial text' }],
    };

    const handleChange = vi.fn((next: AnswerDoc) => {
      currentDoc = next;
    });

    const { rerender } = render(
      <AnswerEditor
        questionId="Q1"
        doc={currentDoc}
        placeholderId="ph-1"
        onChange={handleChange}
      />
    );

    // Click Insert diagram
    const insertBtn = screen.getByRole('button', { name: /Insert diagram/i });
    fireEvent.click(insertBtn);

    expect(currentDoc.blocks.length).toBe(2);
    expect(currentDoc.blocks[1]?.kind).toBe('canvas');

    rerender(
      <AnswerEditor
        questionId="Q1"
        doc={currentDoc}
        placeholderId="ph-1"
        onChange={handleChange}
      />
    );

    // Ensure document undo button exists
    const undoBlockBtn = screen.getByRole('button', { name: /Undo block/i });
    expect(undoBlockBtn).toBeDefined();

    // Blur any active input so document-level shortcut applies
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    // Press Ctrl+Z
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });

    // Restores back to 1 block
    expect(currentDoc.blocks.length).toBe(1);
    expect(currentDoc.blocks[0]?.kind).toBe('paragraph');
  });
});
