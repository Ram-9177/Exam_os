import type { Knex } from '@examos/db';

/**
 * Automatic mark proposals. Deterministic and explainable: the same answer always gets the same proposal, and every
 * proposal says exactly why (which option was chosen, which values were found, which key terms were present or
 * missing). A proposal is never a mark — the examiner records the marks, and any mark that differs from the proposal
 * needs a written reason, which is kept with the result version.
 *
 *  MCQ      expectedAnswer "B" (or ["B","D"] when several keys are each acceptable): the one option the answer chooses.
 *  NUMERIC  expectedAnswer 9.33 | [9.33, 5.33] | { values: [...], tolerance: 0.05 }: share of expected values found.
 *  any      rubric criteria with `keywords` (["mutual exclusion", "hold and wait|hold-and-wait"]): per criterion, the
 *           share of key terms present, rounded down to half marks.
 *  else     no proposal: the examiner marks it (drawings, criteria without key terms).
 */
export type ProposalMethod = 'NO_ANSWER' | 'ANSWER_KEY' | 'NUMERIC_KEY' | 'RUBRIC_TERMS' | 'EXAMINER';

export interface ProposedCriterion {
  code: string;
  max: number;
  awarded: number;
  evidence: string;
}
export interface MarkProposal {
  questionId: string;
  maxMarks: number;
  /** null when the system cannot judge this answer; the examiner marks it without a proposal. */
  proposedMarks: number | null;
  method: ProposalMethod;
  basis: string;
  criteria?: ProposedCriterion[];
  /** CHECK_CAREFULLY when the system gave partial credit somewhere: the examiner should read that part closely. */
  review?: 'ROUTINE' | 'CHECK_CAREFULLY';
}

interface PaperQuestionRow {
  question_id: string;
  kind: string;
  max_marks: number | string;
  options: unknown;
  rubric: unknown;
  expected_answer: unknown;
}

const half = (x: number) => Math.floor(x * 2 + 1e-9) / 2;
/** Nearest half mark, ties up: rounding never works against the student. */
const nearestHalf = (x: number) => Math.round(x * 2 + 1e-9) / 2;

/**
 * Difficulty of a rubric step, 1 (recall a definition) … 10 (hardest synthesis). It decides how much of the step's key
 * terms an answer must cover for full credit: every term at 1, 80 % at the default 5, 55 % at 10 — a demanding step
 * is not failed for missing a phrase, a basic one must be complete. Partial coverage earns proportionally.
 */
export const DEFAULT_DIFFICULTY = 5;
export function fullCreditCoverage(difficulty: number): number {
  const d = Math.min(10, Math.max(1, Math.round(difficulty)));
  return Math.round((1 - (d - 1) * 0.05) * 100) / 100;
}
const norm = (s: string) => s.toLowerCase().replace(/[\u2010-\u2015]/g, '-').replace(/\s+/g, ' ');

/** Everything the student wrote: paragraphs and the text placed on diagrams. */
export function answerText(content: unknown): { text: string; hasDrawing: boolean } {
  const blocks = ((content as { blocks?: Array<{ kind?: string; content?: unknown }> } | null)?.blocks ?? []) as Array<{ kind?: string; content?: unknown }>;
  const parts: string[] = [];
  let hasDrawing = false;
  for (const b of blocks) {
    if (typeof b.content === 'string') parts.push(b.content);
    else if (b.kind === 'canvas' && b.content && typeof b.content === 'object') {
      const strokes = ((b.content as { strokes?: Array<{ text?: unknown }> }).strokes ?? []) as Array<{ text?: unknown }>;
      if (strokes.length) hasDrawing = true;
      for (const s of strokes) if (typeof s.text === 'string') parts.push(s.text);
    }
  }
  return { text: parts.join('\n').trim(), hasDrawing };
}

/** A key term matches as a whole phrase; `a|b` lists alternatives. */
function termFound(text: string, term: string): string | null {
  const t = norm(text);
  for (const alt of term.split('|').map((x) => norm(x.trim())).filter(Boolean)) {
    const escaped = alt.replace(/[.*+?^${}()[\]\\]/g, '\\$&').replace(/[ -]/g, '[ -]?');
    if (new RegExp(`(^|[^a-z0-9])${escaped}`, 'i').test(t)) return alt;
  }
  return null;
}

function mcq(q: PaperQuestionRow, text: string, max: number): MarkProposal | null {
  const keys = (Array.isArray(q.expected_answer) ? q.expected_answer : [q.expected_answer]).filter((k): k is string => typeof k === 'string' && k.trim() !== '').map((k) => k.trim().toUpperCase());
  const options = (Array.isArray(q.options) ? q.options : []) as Array<{ key: string; text: string }>;
  if (!keys.length || !options.length) return null;
  // Only explicit choices count: the bare key ("B"), "(B)", "Option B", "Answer: B", a line that is just the key,
  // or the full text of an option. A capital letter inside a sentence ("A process is…") is not a choice.
  const chosen = new Set<string>();
  const trimmed = text.trim();
  for (const o of options) {
    const k = String(o.key).trim();
    const e = k.replace(/[.*+?^${}()[\]\\]/g, '\\$&');
    // the key letter itself is matched case-sensitively, so "(a)" numbering a point is not option A
    const bare = new RegExp(`^\\s*\\(?${e}\\)?[.)]?\\s*$|\\(${e}\\)`, 'm');
    const worded = new RegExp(`\\b(option|answer)\\s*(is|:|-)?\\s*\\(?(${e})\\b`, 'gi');
    const wordedHit = [...trimmed.matchAll(worded)].some((m) => m[3] === k);
    if (bare.test(trimmed) || wordedHit) chosen.add(k.toUpperCase());
    else if (o.text && norm(text).includes(norm(o.text))) chosen.add(k.toUpperCase());
  }
  const base = { questionId: q.question_id, maxMarks: max, method: 'ANSWER_KEY' as const };
  if (chosen.size === 0) return { ...base, proposedMarks: null, method: 'EXAMINER', basis: 'No option could be read from the answer; the examiner decides.' };
  if (chosen.size > 1) return { ...base, proposedMarks: 0, basis: `More than one option chosen (${[...chosen].join(', ')}); one answer is expected. Key: ${keys.join(' or ')}.` };
  const [c] = [...chosen];
  return keys.includes(c!) ? { ...base, proposedMarks: max, basis: `Chose ${c}, which is the answer key.` } : { ...base, proposedMarks: 0, basis: `Chose ${c}; the answer key is ${keys.join(' or ')}.` };
}

function numeric(q: PaperQuestionRow, text: string, max: number): MarkProposal | null {
  const ea = q.expected_answer;
  let values: number[] = [];
  let tolerance: number | null = null;
  if (typeof ea === 'number') values = [ea];
  else if (Array.isArray(ea)) values = ea.filter((v): v is number => typeof v === 'number');
  else if (ea && typeof ea === 'object') {
    const o = ea as { values?: unknown; value?: unknown; tolerance?: unknown };
    values = (Array.isArray(o.values) ? o.values : [o.value]).filter((v): v is number => typeof v === 'number');
    tolerance = typeof o.tolerance === 'number' ? o.tolerance : null;
  }
  if (!values.length) return null;
  const found = [...text.replace(/(\d),(\d{3})/g, '$1$2').matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  const hits = values.map((v) => found.some((n) => Math.abs(n - v) <= (tolerance ?? Math.max(0.01, Math.abs(v) * 0.01))));
  const n = hits.filter(Boolean).length;
  const marks = half((max * n) / values.length);
  return {
    questionId: q.question_id,
    maxMarks: max,
    proposedMarks: marks,
    method: 'NUMERIC_KEY',
    review: n > 0 && n < values.length ? 'CHECK_CAREFULLY' : 'ROUTINE',
    basis: `${n} of ${values.length} expected ${values.length === 1 ? 'value' : 'values'} found (${values.map((v, i) => `${v}${hits[i] ? ' ✓' : ' ✗'}`).join(', ')}; tolerance ${tolerance ?? '1 %'}). Working is not checked automatically.`,
  };
}

function rubricTerms(q: PaperQuestionRow, text: string, max: number): MarkProposal | null {
  const rubric = (Array.isArray(q.rubric) ? q.rubric : []) as Array<{ code: string; max: number; description: string; keywords?: string[]; difficulty?: number }>;
  if (!rubric.length || rubric.some((c) => !Array.isArray(c.keywords) || c.keywords.length === 0)) return null;
  let partial = false;
  const criteria: ProposedCriterion[] = rubric.map((c) => {
    const kws = c.keywords!;
    const got = kws.filter((k) => termFound(text, k));
    const missing = kws.filter((k) => !got.includes(k));
    const difficulty = typeof c.difficulty === 'number' ? Math.min(10, Math.max(1, Math.round(c.difficulty))) : DEFAULT_DIFFICULTY;
    const needed = fullCreditCoverage(difficulty);
    const credit = Math.min(1, got.length / kws.length / needed);
    if (credit > 0 && credit < 1) partial = true;
    const awarded = Math.min(Number(c.max), nearestHalf(Number(c.max) * credit));
    const names = (xs: string[]) => xs.map((k) => k.split('|')[0]).join(', ');
    return {
      code: c.code,
      max: Number(c.max),
      awarded,
      evidence: `${c.description} · difficulty ${difficulty}/10, full credit at ${Math.round(needed * 100)} % of key terms: ${got.length}/${kws.length} found${got.length ? ` (${names(got)})` : ''}${missing.length ? `; missing: ${names(missing)}` : ''}`,
    };
  });
  const total = Math.min(max, criteria.reduce((a, c) => a + c.awarded, 0));
  return {
    questionId: q.question_id,
    maxMarks: max,
    proposedMarks: total,
    method: 'RUBRIC_TERMS',
    basis: `Each rubric step checked for its key terms; harder steps need fewer of them for full credit. Rounded to the nearest half mark in the student's favour. Correctness of reasoning is the examiner's judgement.`,
    criteria,
    review: partial ? 'CHECK_CAREFULLY' : 'ROUTINE',
  };
}

export function proposeMark(q: PaperQuestionRow, content: unknown): MarkProposal {
  const max = Number(q.max_marks);
  const { text, hasDrawing } = answerText(content);
  if (!text && !hasDrawing) return { questionId: q.question_id, maxMarks: max, proposedMarks: 0, method: 'NO_ANSWER', basis: 'No answer was written.' };
  const p = (q.kind === 'MCQ' ? mcq(q, text, max) : null) ?? (q.kind === 'NUMERIC' ? numeric(q, text, max) : null) ?? (q.kind !== 'DRAWING' ? rubricTerms(q, text, max) : null);
  return p ?? { questionId: q.question_id, maxMarks: max, proposedMarks: null, method: 'EXAMINER', basis: q.kind === 'DRAWING' ? 'Drawings are marked by the examiner.' : 'No answer key or rubric key terms for this question; the examiner marks it.' };
}

/** Proposals for every question of the attempt's approved paper, or null when the exam has no approved paper. */
export async function proposeMarksForAttempt(trx: Knex.Transaction, tenantId: string, examId: string, attemptId: string): Promise<MarkProposal[] | null> {
  const paper = await trx('question_papers').where({ tenant_id: tenantId, exam_id: examId, status: 'APPROVED' }).first('id');
  if (!paper) return null;
  const questions = (await trx('paper_questions').where({ tenant_id: tenantId, paper_id: paper.id }).orderBy('number').select('question_id', 'kind', 'max_marks', 'options', 'rubric', 'expected_answer')) as PaperQuestionRow[];
  const docs = await trx('answer_documents').where({ tenant_id: tenantId, attempt_id: attemptId }).select('question_id', 'content');
  const byQ = new Map(docs.map((d) => [d.question_id as string, typeof d.content === 'string' ? JSON.parse(d.content) : d.content]));
  return questions.map((q) => proposeMark(q, byQ.get(q.question_id) ?? { blocks: [] }));
}

/**
 * The system's evaluation of one sealed script, stored for the marking queue. Upserted: one current snapshot per
 * attempt. What counts at recording time is recomputed from the same paper and answers (deterministic).
 */
export async function snapshotProposals(trx: Knex.Transaction, tenantId: string, examId: string, attemptId: string): Promise<{ proposedTotal: number; maxTotal: number; needsExaminer: number; checkCarefully: number } | null> {
  const proposals = await proposeMarksForAttempt(trx, tenantId, examId, attemptId);
  if (!proposals) return null;
  const proposedTotal = Math.round(proposals.reduce((a, p) => a + (p.proposedMarks ?? 0), 0) * 100) / 100;
  const maxTotal = Math.round(proposals.reduce((a, p) => a + p.maxMarks, 0) * 100) / 100;
  const needsExaminer = proposals.filter((p) => p.proposedMarks === null).length;
  const checkCarefully = proposals.filter((p) => p.review === 'CHECK_CAREFULLY').length;
  await trx('mark_proposals')
    .insert({ tenant_id: tenantId, exam_id: examId, attempt_id: attemptId, proposals: JSON.stringify(proposals), proposed_total: proposedTotal, max_total: maxTotal, needs_examiner: needsExaminer, check_carefully: checkCarefully, computed_at: trx.fn.now() })
    .onConflict('attempt_id')
    .merge(['proposals', 'proposed_total', 'max_total', 'needs_examiner', 'check_carefully', 'computed_at']);
  return { proposedTotal, maxTotal, needsExaminer, checkCarefully };
}
