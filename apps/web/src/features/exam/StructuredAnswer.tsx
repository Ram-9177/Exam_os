import type { AnswerDoc, Block } from '@/lib/answers';

interface Option {
  key: string;
  text: string;
}

interface ChoiceProps {
  questionId: string;
  options: Option[];
  doc: AnswerDoc;
  placeholderId: string;
  disabled: boolean;
  onChange: (next: AnswerDoc) => void;
}

function single(doc: AnswerDoc, kind: Block['kind'], placeholderId: string, content: unknown): AnswerDoc {
  const existing = doc.blocks.find((b) => b.kind === kind);
  return { blocks: [{ id: existing?.id ?? placeholderId, kind, content }] };
}

/** One choice per MCQ, stored as a `choice` block holding the option's key, so marking compares keys rather than typed text. */
export function ChoiceAnswer({ questionId, options, doc, placeholderId, disabled, onChange }: ChoiceProps) {
  const block = doc.blocks.find((b) => b.kind === 'choice');
  const selected = (block?.content as { selected?: string } | null | undefined)?.selected ?? null;
  return (
    <fieldset className="mb-4 space-y-2" disabled={disabled}>
      <legend className="text-ink-2 mb-2">Choose one answer.</legend>
      {options.map((opt) => (
        <label key={opt.key} className="p-3 border border-rule-2 rounded bg-sheet text-sm flex items-start gap-3 cursor-pointer has-[:checked]:border-accent">
          <input type="radio" className="mt-0.5" name={`choice-${questionId}`} value={opt.key} checked={selected === opt.key} onChange={() => onChange(single(doc, 'choice', placeholderId, { selected: opt.key }))} />
          <span className="font-semibold text-ink-2">{opt.key}.</span>
          <span>{opt.text}</span>
        </label>
      ))}
      {selected ? (
        <button type="button" className="text-sm text-accent underline underline-offset-2" onClick={() => onChange({ blocks: [] })}>
          Clear my choice
        </button>
      ) : null}
    </fieldset>
  );
}

interface NumericProps {
  doc: AnswerDoc;
  placeholderId: string;
  disabled: boolean;
  onChange: (next: AnswerDoc) => void;
}

/** A number and nothing else. Stored as a paragraph so it prints and verifies like any other answer. */
export function NumericAnswer({ doc, placeholderId, disabled, onChange }: NumericProps) {
  const block = doc.blocks.find((b) => b.kind === 'paragraph');
  const value = typeof block?.content === 'string' ? block.content : '';
  return (
    <div className="mb-4">
      <label className="block text-ink-2 mb-2" htmlFor="numeric-answer">
        Enter your numeric answer.
      </label>
      <input
        id="numeric-answer"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        disabled={disabled}
        value={value}
        className="w-56 px-3 py-2 border border-rule-2 rounded bg-sheet text-ink font-mono"
        onChange={(e) => {
          const next = e.target.value.trim();
          if (next === '' || /^-?\d*\.?\d*$/.test(next)) onChange(next === '' ? { blocks: [] } : single(doc, 'paragraph', placeholderId, next));
        }}
      />
    </div>
  );
}
