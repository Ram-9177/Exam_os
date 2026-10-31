import { CanvasContentSchema, ChoiceContentSchema, CodeContentSchema, FinalContentSchema, PARAGRAPH_MAX_CHARS, type AnswerSave } from '@examos/contracts';
import { AppError } from '../../lib/errors.js';

/** Hard ceilings for one answer document; the contract's per-block limits apply inside them. */
export const MAX_ANSWER_BLOCKS = 200;
export const MAX_ANSWER_DOCUMENT_BYTES = 4_000_000;
/** Equation and table blocks are opaque JSON until their editors exist; they stay small. */
const MAX_OPAQUE_BLOCK_BYTES = 50_000;

/**
 * Nothing a client sends is trusted: every upserted block is checked against
 * the schema of its kind before it is applied, stored, hashed or ever rendered
 * for a human (the booklet renders drawings as SVG; a malformed point list
 * must never reach it). Returns 422 with a stable code and the offending path.
 */
export function validateAnswerOps(ops: AnswerSave['ops'], current: { blocks: Array<{ id: string; kind: string }> }): void {
  const kinds = new Map(current.blocks.map((b) => [b.id, b.kind]));
  for (const [i, op] of ops.entries()) {
    if (op.op !== 'upsert-block') continue;
    const kind = op.kind ?? kinds.get(op.blockId);
    if (!kind) throw AppError.unprocessable('ANSWER_INVALID', `ops[${i}]: kind is required for a new block`);
    const content = op.content ?? null;
    switch (kind) {
      case 'paragraph':
        if (content !== null && typeof content !== 'string') throw AppError.unprocessable('ANSWER_INVALID', `ops[${i}]: a paragraph is text`);
        if (typeof content === 'string' && content.length > PARAGRAPH_MAX_CHARS) throw AppError.unprocessable('ANSWER_TOO_LARGE', `ops[${i}]: a paragraph holds at most ${PARAGRAPH_MAX_CHARS} characters; continue in a new paragraph`);
        break;
      case 'canvas': {
        const parsed = CanvasContentSchema.safeParse(content);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw AppError.unprocessable('ANSWER_INVALID', `ops[${i}]: drawing ${issue ? `${issue.path.join('.')} ${issue.message}` : 'is not valid'}`);
        }
        break;
      }
      case 'choice': {
        if (!ChoiceContentSchema.safeParse(content).success) throw AppError.unprocessable('ANSWER_INVALID', `ops[${i}]: a choice is {selected: key | [keys] | null}`);
        break;
      }
      case 'final': {
        if (!FinalContentSchema.safeParse(content).success) throw AppError.unprocessable('ANSWER_INVALID', `ops[${i}]: a final answer is {text} of at most 500 characters`);
        break;
      }
      case 'code': {
        if (!CodeContentSchema.safeParse(content).success) throw AppError.unprocessable('ANSWER_INVALID', `ops[${i}]: code is {language: c|cpp|java|python, source} of at most 100,000 characters`);
        break;
      }
      default:
        if (JSON.stringify(content).length > MAX_OPAQUE_BLOCK_BYTES) throw AppError.unprocessable('ANSWER_TOO_LARGE', `ops[${i}]: block too large`);
    }
  }
}

export function assertAnswerDocumentSize(canonical: string, blockCount: number): void {
  if (blockCount > MAX_ANSWER_BLOCKS) throw AppError.unprocessable('ANSWER_TOO_LARGE', `An answer holds at most ${MAX_ANSWER_BLOCKS} blocks`);
  if (canonical.length > MAX_ANSWER_DOCUMENT_BYTES) throw AppError.unprocessable('ANSWER_TOO_LARGE', 'This answer is too large to save as one document; continue in a new diagram or paragraph');
}
