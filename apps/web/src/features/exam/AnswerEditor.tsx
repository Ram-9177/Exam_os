import { forwardRef, useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { CANVAS_BACKGROUNDS, CANVAS_COLORS, CANVAS_LIMITS, CANVAS_TOOLS, type CanvasColor } from '@examos/contracts';
import type { AnswerDoc, Block, CanvasContent, Stroke } from '@/lib/answers';
import { isCanvasContent, paragraphText } from '@/lib/answers';
import { uuid } from '@/lib/ids';
import { Button, cn } from '@/ui';
import { DrawingSurface, emptyCanvas, undoLastStroke, insertDigitalSymbolOnCanvas, type DrawingTool } from '@/features/drawing/DrawingSurface';
import { MathPalette } from '@/features/drawing/MathPalette';

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
 * (inline whiteboards), in document order. Copy/paste works inside the
 * workspace; pasting from outside is refused and logged, not punished.
 */
export function AnswerEditor({ questionId, doc, placeholderId, onChange, disabled = false, onExternalPaste }: AnswerEditorProps) {
  const blocks = normaliseDoc(doc, placeholderId).blocks;
  const firstRef = useRef<HTMLTextAreaElement>(null);
  const [docHistory, setDocHistory] = useState<AnswerDoc[]>([]);
  const [docFuture, setDocFuture] = useState<AnswerDoc[]>([]);

  useEffect(() => {
    firstRef.current?.focus({ preventScroll: true });
  }, [questionId]);

  const pushDoc = useCallback(
    (next: AnswerDoc) => {
      setDocHistory((prev) => [...prev.slice(-30), doc]);
      setDocFuture([]);
      onChange(next);
    },
    [doc, onChange],
  );

  const undoDoc = useCallback(() => {
    if (docHistory.length === 0) return;
    const prev = docHistory[docHistory.length - 1]!;
    setDocHistory((h) => h.slice(0, -1));
    setDocFuture((f) => [...f, doc]);
    onChange(prev);
  }, [doc, docHistory, onChange]);

  const redoDoc = useCallback(() => {
    if (docFuture.length === 0) return;
    const next = docFuture[docFuture.length - 1]!;
    setDocFuture((f) => f.slice(0, -1));
    setDocHistory((h) => [...h, doc]);
    onChange(next);
  }, [doc, docFuture, onChange]);

  const update = (id: string, content: unknown) => onChange({ blocks: blocks.map((b) => (b.id === id ? { ...b, content } : b)) });
  const insertAfter = (id: string | null, block: Block) => {
    const idx = id ? blocks.findIndex((b) => b.id === id) : -1;
    const next = [...blocks];
    next.splice(idx + 1, 0, block);
    pushDoc({ blocks: next });
  };
  const remove = (id: string) => pushDoc(normaliseDoc({ blocks: blocks.filter((b) => b.id !== id) }, placeholderId));

  // Global document-level keyboard shortcut for block actions (when not typing inside a textarea or drawing on a canvas)
  useEffect(() => {
    if (disabled) return;
    const onDocKey = (e: globalThis.KeyboardEvent) => {
      const active = document.activeElement;
      const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'CANVAS');
      if (isInput) return;
      if (active?.closest('figure')) return;

      const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;

      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        if (docHistory.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          undoDoc();
        }
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        if (docFuture.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          redoDoc();
        }
      }
    };

    window.addEventListener('keydown', onDocKey);
    return () => window.removeEventListener('keydown', onDocKey);
  }, [disabled, docHistory.length, docFuture.length, undoDoc, redoDoc]);

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
      {(docHistory.length > 0 || docFuture.length > 0) && !disabled ? (
        <div className="flex items-center gap-2 text-xs text-ink-3">
          <Button size="sm" variant="ghost" onClick={undoDoc} disabled={docHistory.length === 0} title="Undo block action (Ctrl+Z / ⌘Z)">
            ↶ Undo block (Ctrl+Z)
          </Button>
          <Button size="sm" variant="ghost" onClick={redoDoc} disabled={docFuture.length === 0} title="Redo block action (Ctrl+Y / ⌘Shift+Z)">
            ↷ Redo block (Ctrl+Y)
          </Button>
        </div>
      ) : null}
      {blocks.map((b, i) => (
        <div key={b.id} className="group">
          {b.kind === 'canvas' && isCanvasContent(b.content) ? (
            <DiagramBlock
              content={b.content}
              onChange={(c) => update(b.id, c)}
              onRemove={() => remove(b.id)}
              disabled={disabled}
              index={i + 1}
              onInsertToParagraph={(text) => {
                const target = blocks.find((blk) => blk.kind === 'paragraph');
                if (target) {
                  const current = typeof target.content === 'string' ? target.content : '';
                  update(target.id, current ? `${current} ${text}` : text);
                }
              }}
            />
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

// ---------------------------------------------------------------------------
// Whiteboard block
// ---------------------------------------------------------------------------
export const TOOL_LABEL: Record<DrawingTool, string> = { pen: 'Pen', highlighter: 'Highlighter', eraser: 'Eraser', line: 'Line', arrow: 'Arrow', rect: 'Rectangle', ellipse: 'Ellipse', text: 'Text' };
export const COLOR_LABEL: Record<CanvasColor, string> = { ink: 'Ink', blue: 'Blue', red: 'Red', green: 'Green', orange: 'Orange', purple: 'Purple' };
const BACKGROUND_LABEL: Record<(typeof CANVAS_BACKGROUNDS)[number], string> = { blank: 'Plain', grid: 'Grid', ruled: 'Ruled', dots: 'Dots' };
const WIDTHS = [
  { label: 'Thin', value: 1.5 },
  { label: 'Medium', value: 2.5 },
  { label: 'Thick', value: 5 },
] as const;
const TEXT_SIZES = [
  { label: 'Small text', value: 14 },
  { label: 'Normal text', value: 18 },
  { label: 'Large text', value: 26 },
] as const;
const GROW_BY = 240;

/**
 * One diagram: a toolbar (tools, colour, width, fill, text size, paper,
 * undo/redo, clear, taller) over the drawing surface. Every action is a plain
 * button so it works with a keyboard and a screen reader; state that matters
 * for marking (the items) lives in the answer document, the rest is local.
 */
function DiagramBlock({
  content,
  onChange,
  onRemove,
  disabled,
  index,
  onInsertToParagraph,
}: {
  content: CanvasContent;
  onChange: (c: CanvasContent) => void;
  onRemove: () => void;
  disabled: boolean;
  index: number;
  onInsertToParagraph?: (text: string) => void;
}) {
  const figureRef = useRef<HTMLElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const lastActiveRef = useRef(0);
  const [tool, setTool] = useState<DrawingTool>('pen');
  const [color, setColor] = useState<CanvasColor>('ink');
  const [width, setWidth] = useState<number>(WIDTHS[1].value);
  const [textSize, setTextSize] = useState<number>(TEXT_SIZES[1].value);
  const [fill, setFill] = useState(false);
  const [showMath, setShowMath] = useState(false);
  const [autoConvert, setAutoConvert] = useState(false);
  const [redo, setRedo] = useState<Stroke[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);
  const [limitNote, setLimitNote] = useState(false);
  const items = content.strokes.filter((s) => s.tool !== 'eraser').length;
  const shape = tool === 'rect' || tool === 'ellipse';

  const draw = useCallback((next: CanvasContent) => {
    setRedo([]);
    setLimitNote(false);
    lastActiveRef.current = Date.now();
    onChange(next);
  }, [onChange]);

  const undo = useCallback(() => {
    const last = content.strokes[content.strokes.length - 1];
    if (!last) return;
    setRedo((r) => [...r, last]);
    lastActiveRef.current = Date.now();
    onChange(undoLastStroke(content));
  }, [content, onChange]);

  const redoLast = useCallback(() => {
    const item = redo[redo.length - 1];
    if (!item) return;
    setRedo((r) => r.slice(0, -1));
    lastActiveRef.current = Date.now();
    onChange({ ...content, strokes: [...content.strokes, item] });
  }, [content, redo, onChange]);

  // Keyboard shortcut listener: Ctrl+Z / Cmd+Z to undo, Ctrl+Y / Cmd+Shift+Z to redo
  useEffect(() => {
    if (disabled) return;
    const handleDiagramKeyDown = (e: globalThis.KeyboardEvent) => {
      const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;

      const key = e.key.toLowerCase();
      const isUndo = key === 'z' && !e.shiftKey;
      const isRedo = key === 'y' || (key === 'z' && e.shiftKey);
      if (!isUndo && !isRedo) return;

      const active = document.activeElement;
      // If focused inside a text input outside this diagram, let that input handle native typing undo
      const isExternalInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && !figureRef.current?.contains(active);
      if (isExternalInput) return;

      // Handle if focused inside this figure, or hovered, or recently drawn on (< 45s)
      const isRecent = Date.now() - lastActiveRef.current < 45_000;
      const isTarget = isHovered || (figureRef.current && (figureRef.current === active || figureRef.current.contains(active))) || isRecent;
      if (!isTarget) return;

      if (isUndo && content.strokes.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        undo();
      } else if (isRedo && redo.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        redoLast();
      }
    };

    window.addEventListener('keydown', handleDiagramKeyDown, true);
    return () => window.removeEventListener('keydown', handleDiagramKeyDown, true);
  }, [disabled, isHovered, content.strokes.length, redo.length, undo, redoLast]);

  const clear = () => {
    setConfirmClear(false);
    setRedo([]);
    onChange({ ...content, strokes: [] });
  };
  const setBackground = (kind: string) => {
    const { background: _omit, ...rest } = content;
    onChange(kind === 'blank' ? rest : { ...rest, background: kind as CanvasContent['background'] });
  };
  const taller = () => onChange({ ...content, height: Math.min(CANVAS_LIMITS.maxHeight, content.height + GROW_BY) });

  const handleInsertMath = (symbolOrFormula: string) => {
    const next = insertDigitalSymbolOnCanvas(content, symbolOrFormula, {
      color,
      size: textSize,
    });
    draw(next);
  };

  return (
    <figure
      ref={figureRef}
      role="figure"
      aria-label={`Diagram ${index}`}
      data-testid={`diagram-${index}`}
      tabIndex={0}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onFocus={() => setIsHovered(true)}
      onBlur={(e) => {
        if (!figureRef.current?.contains(e.relatedTarget as Node)) {
          setIsHovered(false);
        }
      }}
      className="border border-rule-2 rounded-sm overflow-hidden bg-sheet focus-within:ring-1 focus-within:ring-accent outline-none"
    >
      <figcaption className="flex flex-col gap-2 px-3 py-2 border-b border-rule bg-sheet-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium mr-2">Diagram {index}</span>
          {!disabled ? (
            <div role="toolbar" aria-label={`Diagram ${index} tools`} className="flex flex-wrap gap-1">
              {CANVAS_TOOLS.map((t) => (
                <Button key={t} size="sm" variant={tool === t ? 'primary' : 'secondary'} aria-pressed={tool === t} onClick={() => setTool(t)}>
                  {TOOL_LABEL[t]}
                </Button>
              ))}
              <span className="w-px h-5 bg-rule mx-1 self-center" aria-hidden="true" />
              <Button
                size="sm"
                variant={showMath ? 'primary' : 'secondary'}
                aria-pressed={showMath}
                onClick={() => setShowMath((s) => !s)}
                title="Open math formulas, keys, and calculus symbols palette"
              >
                ∑ fx Math
              </Button>
              <Button
                size="sm"
                variant={autoConvert ? 'primary' : 'ghost'}
                aria-pressed={autoConvert}
                onClick={() => setAutoConvert((a) => !a)}
                title="Automatically convert hand-drawn shapes and math symbols (e.g. √, ∫, ∑, π, ∞) to digital items"
              >
                ✨ {autoConvert ? 'Auto-convert: ON' : 'Auto-convert: OFF'}
              </Button>
            </div>
          ) : null}
          <span className="ml-auto text-ink-2 tabular">
            {items} {items === 1 ? 'item' : 'items'}
          </span>
          {!disabled ? (
            <Button size="sm" variant="ghost" onClick={onRemove}>
              Remove diagram
            </Button>
          ) : null}
        </div>

        {showMath && !disabled ? (
          <MathPalette
            onInsertToCanvas={handleInsertMath}
            onInsertToParagraph={onInsertToParagraph}
            onClose={() => setShowMath(false)}
            className="my-1 border-accent/40 bg-sheet shadow-xs"
          />
        ) : null}
        {!disabled ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div role="group" aria-label={`Diagram ${index} colour`} className="flex items-center gap-1">
              {(Object.keys(CANVAS_COLORS) as CanvasColor[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`${COLOR_LABEL[c]} colour`}
                  aria-pressed={color === c}
                  disabled={tool === 'eraser'}
                  onClick={() => setColor(c)}
                  className={cn('h-6 w-6 rounded-full border-2 transition-transform disabled:opacity-40', color === c ? 'border-ink scale-110' : 'border-rule-2')}
                  style={{ backgroundColor: c === 'ink' ? 'var(--ink)' : CANVAS_COLORS[c] }}
                />
              ))}
            </div>
            <div role="group" aria-label={`Diagram ${index} line width`} className="flex gap-1">
              {WIDTHS.map((w) => (
                <Button key={w.label} size="sm" variant={width === w.value ? 'secondary' : 'ghost'} aria-pressed={width === w.value} onClick={() => setWidth(w.value)}>
                  {w.label}
                </Button>
              ))}
            </div>
            {shape ? (
              <Button size="sm" variant={fill ? 'secondary' : 'ghost'} aria-pressed={fill} onClick={() => setFill((f) => !f)}>
                Fill
              </Button>
            ) : null}
            {tool === 'text' ? (
              <div role="group" aria-label={`Diagram ${index} text size`} className="flex gap-1">
                {TEXT_SIZES.map((t) => (
                  <Button key={t.label} size="sm" variant={textSize === t.value ? 'secondary' : 'ghost'} aria-pressed={textSize === t.value} onClick={() => setTextSize(t.value)}>
                    {t.label}
                  </Button>
                ))}
              </div>
            ) : null}
            <label className="flex items-center gap-2 text-ink-2">
              Paper
              <select value={content.background ?? 'blank'} onChange={(e) => setBackground(e.target.value)} className="rounded-sm border border-rule-2 bg-sheet px-2 py-1 text-ink" aria-label={`Diagram ${index} paper`}>
                {CANVAS_BACKGROUNDS.map((k) => (
                  <option key={k} value={k}>
                    {BACKGROUND_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-1 ml-auto">
              <Button size="sm" onClick={undo} disabled={content.strokes.length === 0} title="Undo stroke (Ctrl+Z / ⌘Z)">
                Undo
              </Button>
              <Button size="sm" onClick={redoLast} disabled={redo.length === 0} title="Redo stroke (Ctrl+Y / ⌘Shift+Z)">
                Redo
              </Button>
              <Button size="sm" variant="ghost" onClick={taller} disabled={content.height >= CANVAS_LIMITS.maxHeight}>
                Taller
              </Button>
              {confirmClear ? (
                <>
                  <Button size="sm" variant="danger" onClick={clear}>
                    Clear everything
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>
                    Keep
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setConfirmClear(true)} disabled={content.strokes.length === 0}>
                  Clear
                </Button>
              )}
            </div>
          </div>
        ) : null}
        {limitNote ? (
          <p className="text-fix" role="status">
            This diagram is full. Add a new diagram below to keep drawing.
          </p>
        ) : null}
      </figcaption>
      <DrawingSurface
        value={content}
        onChange={draw}
        tool={tool}
        color={color}
        penWidth={width}
        fill={fill}
        textSize={textSize}
        readOnly={disabled}
        label={`Diagram ${index}`}
        onLimit={() => setLimitNote(true)}
        autoConvertMath={autoConvert}
        onUndo={undo}
        onRedo={redoLast}
      />
    </figure>
  );
}
