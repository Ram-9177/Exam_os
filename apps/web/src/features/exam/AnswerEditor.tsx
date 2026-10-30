import { forwardRef, useEffect, useRef, useState, type ClipboardEvent } from 'react';
import type { AnswerDoc, Block, CanvasContent } from '@/lib/answers';
import { isCanvasContent, paragraphText } from '@/lib/answers';
import { uuid } from '@/lib/ids';
import { Button, cn } from '@/ui';
import { DrawingSurface, emptyCanvas, undoLastStroke, type DrawingTool } from '@/features/drawing/DrawingSurface';

const INTERNAL_MIME = 'text/x-examos-internal';

export function newParagraph(text = ''): Block {
  return { id: `b-${uuid()}`, kind: 'paragraph', content: text };
}
export function newCanvas(): Block {
  return { id: `b-${uuid()}`, kind: 'canvas', content: emptyCanvas(800, 480) };
}

/**
 * Guarantees a document always has at least one paragraph to type into. The
 * placeholder id must be stable across renders (pass one per question),
 * otherwise React remounts the textarea and typing is lost.
 */
export function normaliseDoc(doc: AnswerDoc, placeholderId: string): AnswerDoc {
  return doc.blocks.length === 0 ? { blocks: [{ id: placeholderId, kind: 'paragraph', content: '' }] } : doc;
}

export interface AnswerEditorProps {
  questionId: string;
  doc: AnswerDoc;
  /** Stable id used for the empty-document placeholder paragraph. */
  placeholderId: string;
  onChange: (next: AnswerDoc) => void;
  disabled?: boolean;
  onExternalPaste?: () => void;
}

/**
 * The answer sheet: paragraph blocks (textareas that grow) and diagram blocks
 * (inline canvases), in document order. Copy/paste works inside the workspace;
 * pasting from outside is refused and logged, not punished.
 */
export function AnswerEditor({ questionId, doc, placeholderId, onChange, disabled = false, onExternalPaste }: AnswerEditorProps) {
  const blocks = normaliseDoc(doc, placeholderId).blocks;
  const firstRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    firstRef.current?.focus({ preventScroll: true });
  }, [questionId]);

  const update = (id: string, content: unknown) => onChange({ blocks: blocks.map((b) => (b.id === id ? { ...b, content } : b)) });
  const insertAfter = (id: string | null, block: Block) => {
    const idx = id ? blocks.findIndex((b) => b.id === id) : -1;
    const next = [...blocks];
    next.splice(idx + 1, 0, block);
    onChange({ blocks: next });
  };
  const remove = (id: string) => onChange(normaliseDoc({ blocks: blocks.filter((b) => b.id !== id) }, placeholderId));

  const onCopy = (e: ClipboardEvent) => {
    const sel = typeof window !== 'undefined' ? window.getSelection()?.toString() : '';
    if (!sel) return;
    e.clipboardData.setData('text/plain', sel);
    e.clipboardData.setData(INTERNAL_MIME, '1');
    e.preventDefault();
  };
  const onPaste = (e: ClipboardEvent) => {
    if (e.clipboardData.types.includes(INTERNAL_MIME)) return;
    e.preventDefault();
    onExternalPaste?.();
  };

  return (
    <div className="flex flex-col gap-4" onCopy={onCopy} onCut={onCopy} onPaste={onPaste}>
      {blocks.map((b, i) => (
        <div key={b.id} className="group">
          {b.kind === 'canvas' && isCanvasContent(b.content) ? (
            <DiagramBlock content={b.content} onChange={(c) => update(b.id, c)} onRemove={() => remove(b.id)} disabled={disabled} index={i + 1} />
          ) : (
            <ParagraphBlock ref={i === 0 ? firstRef : undefined} value={paragraphText(b)} onChange={(t) => update(b.id, t)} disabled={disabled} label={`Answer paragraph ${i + 1}`} onRemove={blocks.length > 1 ? () => remove(b.id) : undefined} />
          )}
          <div className={cn('flex gap-2 mt-2 text-sm', disabled && 'hidden')}>
            <Button size="sm" variant="ghost" onClick={() => insertAfter(b.id, newCanvas())}>
              Insert diagram
            </Button>
            {b.kind === 'canvas' ? (
              <Button size="sm" variant="ghost" onClick={() => insertAfter(b.id, newParagraph())}>
                Add paragraph
              </Button>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}


const ParagraphBlock = forwardRef<HTMLTextAreaElement, { value: string; onChange: (t: string) => void; disabled: boolean; label: string; onRemove?: () => void }>(function ParagraphBlock({ value, onChange, disabled, label, onRemove }, ref) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const setRefs = (el: HTMLTextAreaElement | null) => {
    innerRef.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight, 160)}px`;
  }, [value]);
  return (
    <div className="relative">
      <textarea
        ref={setRefs}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-label={label}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="sentences"
        className="ruled ruled-inset w-full resize-none rounded-sm border border-rule-2 py-0 text-[17px] text-ink outline-none focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-0 disabled:opacity-70"
        style={{ fontFamily: 'var(--font-sans)', minHeight: 160 }}
      />
      {onRemove && !disabled ? (
        <button type="button" onClick={onRemove} className="absolute top-1 right-1 text-xs text-ink-3 hover:text-stop px-1.5 py-0.5 rounded-sm opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label={`Remove ${label.toLowerCase()}`}>
          Remove
        </button>
      ) : null}
    </div>
  );
});

function DiagramBlock({ content, onChange, onRemove, disabled, index }: { content: CanvasContent; onChange: (c: CanvasContent) => void; onRemove: () => void; disabled: boolean; index: number }) {
  const [tool, setTool] = useState<DrawingTool>('pen');
  return (
    <figure className="border border-rule-2 rounded-sm overflow-hidden bg-sheet">
      <figcaption className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-rule bg-sheet-2 text-sm">
        <span className="font-medium mr-2">Diagram {index}</span>
        {!disabled ? (
          <div role="toolbar" aria-label={`Diagram ${index} tools`} className="flex gap-1">
            <Button size="sm" variant={tool === 'pen' ? 'primary' : 'secondary'} aria-pressed={tool === 'pen'} onClick={() => setTool('pen')}>
              Pen
            </Button>
            <Button size="sm" variant={tool === 'eraser' ? 'primary' : 'secondary'} aria-pressed={tool === 'eraser'} onClick={() => setTool('eraser')}>
              Eraser
            </Button>
            <Button size="sm" onClick={() => onChange(undoLastStroke(content))} disabled={content.strokes.length === 0}>
              Undo
            </Button>
          </div>
        ) : null}
        <span className="ml-auto text-ink-2 tabular">
          {content.strokes.length} {content.strokes.length === 1 ? 'stroke' : 'strokes'}
        </span>
        {!disabled ? (
          <Button size="sm" variant="ghost" onClick={onRemove}>
            Remove diagram
          </Button>
        ) : null}
      </figcaption>
      <DrawingSurface value={content} onChange={onChange} tool={tool} readOnly={disabled} label={`Diagram ${index}`} />
    </figure>
  );
}
