import { describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { classifyAddedElement, useIntegrityWatch } from '@/features/exam/integrity-watch';
import { SignalReporter, type SignalEvent } from '@/lib/signals';

function Workspace({ reporter }: { reporter: SignalReporter }) {
  useIntegrityWatch({ active: true, reporter });
  const [v, setV] = useState('');
  return <textarea aria-label="Answer to question 1" value={v} onChange={(e) => setV(e.target.value)} />;
}
function setup() {
  const sent: SignalEvent[] = [];
  const reporter = new SignalReporter({ attemptId: 'a1', minIntervalMs: 0, send: async (ev) => void sent.push(...ev) });
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  const view = render(<Workspace reporter={reporter} />, { container: root });
  return { sent, root, view, cleanup: () => (view.unmount(), root.remove()) };
}
const ofClass = (sent: SignalEvent[], c: string) => sent.filter((e) => e.signalClass === c);

describe('integrity watch: AI tools and extensions inside the exam page', () => {
  it('flags what an extension puts into the page, once per kind, and leaves ExamOS’s own content alone', async () => {
    const { sent, root, cleanup } = setup();
    // ExamOS's own: content in #root, its dialogs, styles
    const mine = document.createElement('div');
    root.appendChild(mine);
    const dialog = document.createElement('div');
    dialog.setAttribute('data-examos-portal', '');
    dialog.appendChild(document.createElement('section'));
    document.body.appendChild(dialog);
    document.head.appendChild(document.createElement('style'));
    await new Promise((r) => setTimeout(r, 0));
    expect(ofClass(sent, 'PAGE_TAMPERED')).toHaveLength(0);

    // an AI sidebar: a frame from the extension, twice (re-rendered) → one report
    for (let i = 0; i < 2; i++) {
      const f = document.createElement('iframe');
      f.src = 'chrome-extension://abcdefghijklmnop/sidebar.html';
      document.body.appendChild(f);
    }
    // a writing assistant's widget inside the editor area
    root.appendChild(document.createElement('grammarly-extension'));
    // an overlay div added straight to <body>
    document.body.appendChild(document.createElement('div'));
    await waitFor(() => expect(ofClass(sent, 'PAGE_TAMPERED')).toHaveLength(3));
    expect(ofClass(sent, 'PAGE_TAMPERED').map((e) => e.metadata)).toEqual([
      { kind: 'extension-resource', tag: 'iframe', origin: 'chrome-extension://abcdefghijklmnop' },
      { kind: 'element', tag: 'grammarly-extension', origin: null },
      { kind: 'overlay', tag: 'div', origin: null },
    ]);
    cleanup();
    document.querySelectorAll('iframe,[data-examos-portal]').forEach((n) => n.remove());
  });

  it('classifies frames, foreign scripts and extension files; same-origin scripts are not flagged', () => {
    const root = document.createElement('div');
    const el = (tag: string) => document.createElement(tag);
    const s1 = el('script');
    s1.setAttribute('src', 'https://cdn.example.com/helper.js');
    const s2 = el('script');
    s2.setAttribute('src', '/assets/app.js');
    const img = el('img');
    img.setAttribute('src', 'moz-extension://123/icon.png');
    expect(classifyAddedElement(s1, root)).toMatchObject({ kind: 'script', origin: 'https://cdn.example.com' });
    expect(classifyAddedElement(s2, root)).toBeNull();
    expect(classifyAddedElement(img, root)).toMatchObject({ kind: 'extension-resource' });
    expect(classifyAddedElement(el('iframe'), root)).toMatchObject({ kind: 'frame' });
  });

  it('flags answer text put in by a script, and large blocks inserted at once; ordinary typing is not flagged', async () => {
    const { sent, view, cleanup } = setup();
    const box = view.getByLabelText('Answer to question 1') as HTMLTextAreaElement;
    await userEvent.type(box, 'A process is a program in execution.');
    expect(ofClass(sent, 'TEXT_NOT_TYPED')).toHaveLength(0);
    // an extension writes the answer and announces it with a synthetic input event
    box.value += ' '.padEnd(300, 'x');
    box.dispatchEvent(Object.assign(new Event('input', { bubbles: true }), { fromScript: true }));
    await waitFor(() => expect(ofClass(sent, 'TEXT_NOT_TYPED')).toHaveLength(1));
    expect(ofClass(sent, 'TEXT_NOT_TYPED')[0]!.metadata).toMatchObject({ reason: 'untrusted', chars: 300, field: 'Answer to question 1' });
    // an assistant's "replace with" suggestion
    box.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertReplacementText', data: 'Threads share the address space of their process.' }));
    expect(ofClass(sent, 'TEXT_NOT_TYPED')[1]!.metadata).toMatchObject({ reason: 'bulk', inputType: 'insertReplacementText' });
    cleanup();
  });
});
