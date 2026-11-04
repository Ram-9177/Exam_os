import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnswerEditor } from '@/features/exam/AnswerEditor';
import { INTERNAL_MIME } from '@/lib/answers';

describe('Proctor Security & Integrity Controls', () => {
  it('blocks external paste on answer textarea and fires onExternalPaste callback', async () => {
    let externalPasteFired = false;
    let doc = { blocks: [{ id: 'b1', kind: 'paragraph' as const, content: 'Initial text' }] };

    render(
      <AnswerEditor
        questionId="Q1"
        doc={doc}
        placeholderId="b1"
        onChange={(next) => { doc = next; }}
        onExternalPaste={() => {
          externalPasteFired = true;
        }}
      />
    );

    const textarea = screen.getByRole('textbox', { name: /answer paragraph 1/i });

    // Simulate external paste: paste event without INTERNAL_MIME type
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        types: ['text/plain'],
        getData: (type: string) => (type === 'text/plain' ? 'Cheated external answer' : ''),
      },
    });

    fireEvent(textarea, pasteEvent);

    // Event should be cancelled (default prevented) and onExternalPaste callback invoked
    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(externalPasteFired).toBe(true);
    // Textarea value should remain unchanged
    expect(textarea).toHaveValue('Initial text');
  });

  it('allows internal paste when INTERNAL_MIME is present in clipboard types', async () => {
    let externalPasteFired = false;
    let doc = { blocks: [{ id: 'b1', kind: 'paragraph' as const, content: 'Initial text' }] };

    render(
      <AnswerEditor
        questionId="Q1"
        doc={doc}
        placeholderId="b1"
        onChange={(next) => { doc = next; }}
        onExternalPaste={() => {
          externalPasteFired = true;
        }}
      />
    );

    const textarea = screen.getByRole('textbox', { name: /answer paragraph 1/i });

    // Simulate internal paste with INTERNAL_MIME
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        types: ['text/plain', INTERNAL_MIME],
        getData: (type: string) => (type === 'text/plain' ? 'Legitimate internal note' : ''),
      },
    });

    fireEvent(textarea, pasteEvent);

    // Should NOT be prevented by our security check
    expect(pasteEvent.defaultPrevented).toBe(false);
    expect(externalPasteFired).toBe(false);
  });

  it('prevents context menu (right click) on answer textareas to block right-click paste', async () => {
    const doc = { blocks: [{ id: 'b1', kind: 'paragraph' as const, content: 'Some text' }] };

    render(
      <AnswerEditor
        questionId="Q1"
        doc={doc}
        placeholderId="b1"
        onChange={() => {}}
      />
    );

    const textarea = screen.getByRole('textbox', { name: /answer paragraph 1/i });
    const contextMenuEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(textarea, contextMenuEvent);

    expect(contextMenuEvent.defaultPrevented).toBe(true);
  });

  it('blocks drag and drop on answer textareas', async () => {
    let externalPasteFired = false;
    const doc = { blocks: [{ id: 'b1', kind: 'paragraph' as const, content: 'Some text' }] };

    render(
      <AnswerEditor
        questionId="Q1"
        doc={doc}
        placeholderId="b1"
        onChange={() => {}}
        onExternalPaste={() => {
          externalPasteFired = true;
        }}
      />
    );

    const textarea = screen.getByRole('textbox', { name: /answer paragraph 1/i });
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true });
    fireEvent(textarea, dropEvent);

    expect(dropEvent.defaultPrevented).toBe(true);
    expect(externalPasteFired).toBe(true);
  });
});
