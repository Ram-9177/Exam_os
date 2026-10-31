import type { CanvasContentWire, CanvasItem, CodeLanguage } from '@examos/contracts';
import { canonicalJson, sha256Hex } from './canonical';

/**
 * Hybrid answer document (spec §7): an ordered list of blocks. Paragraph blocks
 * carry plain text; canvas blocks carry vector strokes. Equation and table
 * kinds are accepted by the API but the editor does not create them yet.
 */
export type BlockKind = 'paragraph' | 'equation' | 'table' | 'canvas' | 'choice' | 'final' | 'code';
/** Blocks with their own controls (option buttons, final-answer box, code editor), not shown as paragraphs. */
export const STRUCTURED_KINDS: readonly BlockKind[] = ['choice', 'final', 'code'];
export type CodeLanguageId = CodeLanguage;

/** Whether a block holds something the student wrote or chose. */
export function blockHasContent(b: Block): boolean {
  const c = b.content as Record<string, unknown> | string | null | undefined;
  if (typeof c === 'string') return c.trim().length > 0;
  if (!c) return false;
  if (b.kind === 'choice') return Array.isArray(c['selected']) ? (c['selected'] as unknown[]).length > 0 : c['selected'] !== null && c['selected'] !== undefined;
  if (b.kind === 'final') return typeof c['text'] === 'string' && c['text'].trim().length > 0;
  if (b.kind === 'code') {
    const files = c['files'] && typeof c['files'] === 'object' ? Object.values(c['files'] as Record<string, unknown>) : [];
    return (typeof c['source'] === 'string' && c['source'].trim().length > 0) || files.some((f) => typeof f === 'string' && f.trim().length > 0);
  }
  return true;
}

export interface Block {
  id: string;
  kind: BlockKind;
  content: unknown;
}

/**
 * Whiteboard content is the contract's wire shape: items (pen, highlighter,
 * eraser, line, arrow, rect, ellipse, text) over an optional ruled/grid/dot
 * background. A point is [x, y] in canvas pixels, optionally followed by
 * pressure 0..1.
 */
export type StrokePoint = CanvasItem['points'][number];
export type Stroke = CanvasItem;
export type CanvasContent = CanvasContentWire;

export interface AnswerDoc {
  blocks: Block[];
}

export interface AnswerOp {
  op: 'upsert-block' | 'delete-block' | 'reorder';
  blockId: string;
  kind?: BlockKind;
  content?: unknown;
  after?: string | null;
}

export const EMPTY_DOC: AnswerDoc = { blocks: [] };

export function isCanvasContent(v: unknown): v is CanvasContent {
  return !!v && typeof v === 'object' && Array.isArray((v as CanvasContent).strokes);
}

export function paragraphText(b: Block): string {
  return typeof b.content === 'string' ? b.content : '';
}

/** Only the three wire fields take part in hashing; client-side extras never do. */
export function wireDoc(doc: AnswerDoc): AnswerDoc {
  return { blocks: doc.blocks.map((b) => ({ id: b.id, kind: b.kind, content: b.content === undefined ? null : b.content })) };
}

export function docsEqual(a: AnswerDoc, b: AnswerDoc): boolean {
  return canonicalJson(wireDoc(a)) === canonicalJson(wireDoc(b));
}

/** SHA-256 of the canonical JSON of {blocks:[{id,kind,content}]} — identical to the API's contentHash. */
export async function contentHash(doc: AnswerDoc): Promise<string> {
  return sha256Hex(canonicalJson(wireDoc(doc)));
}

/** Mirror of the API's applyOps (apps/api/src/modules/attempts/service.ts). Keep in lock-step. */
export function applyOps(content: AnswerDoc, ops: readonly AnswerOp[]): AnswerDoc {
  const blocks = [...content.blocks];
  for (const op of ops) {
    const idx = blocks.findIndex((b) => b.id === op.blockId);
    if (op.op === 'upsert-block') {
      const block: Block = { id: op.blockId, kind: op.kind ?? blocks[idx]?.kind ?? 'paragraph', content: op.content ?? null };
      if (idx >= 0) blocks[idx] = block;
      else blocks.push(block);
    } else if (op.op === 'delete-block') {
      if (idx >= 0) blocks.splice(idx, 1);
    } else if (op.op === 'reorder') {
      if (idx < 0) continue;
      const [b] = blocks.splice(idx, 1);
      if (!b) continue;
      if (op.after === null || op.after === undefined) blocks.unshift(b);
      else {
        const after = blocks.findIndex((x) => x.id === op.after);
        blocks.splice(after < 0 ? blocks.length : after + 1, 0, b);
      }
    }
  }
  return { blocks };
}

/**
 * Builds the smallest op list that turns `base` (last server-acknowledged
 * document) into `next` (the local draft): upserts for new/changed blocks,
 * deletes for removed blocks, then reorders only when the resulting order
 * still differs. applyOps(base, buildOps(base, next)) ≡ next.
 */
export function buildOps(base: AnswerDoc, next: AnswerDoc): AnswerOp[] {
  const ops: AnswerOp[] = [];
  const baseById = new Map(base.blocks.map((b) => [b.id, b] as const));
  const nextIds = new Set(next.blocks.map((b) => b.id));

  for (const b of next.blocks) {
    const prev = baseById.get(b.id);
    const content = b.content === undefined ? null : b.content;
    if (!prev || prev.kind !== b.kind || canonicalJson(prev.content ?? null) !== canonicalJson(content)) {
      ops.push({ op: 'upsert-block', blockId: b.id, kind: b.kind, content });
    }
  }
  for (const b of base.blocks) if (!nextIds.has(b.id)) ops.push({ op: 'delete-block', blockId: b.id });

  const afterUpserts = applyOps(base, ops);
  const sameOrder = afterUpserts.blocks.length === next.blocks.length && afterUpserts.blocks.every((b, i) => b.id === next.blocks[i]?.id);
  if (!sameOrder) {
    let prevId: string | null = null;
    for (const b of next.blocks) {
      ops.push({ op: 'reorder', blockId: b.id, after: prevId });
      prevId = b.id;
    }
  }
  return ops;
}
