import type { Knex } from '@examos/db';
import { equivalent } from './math-equivalence.js';

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
export type ProposalMethod = 'NO_ANSWER' | 'ANSWER_KEY' | 'NUMERIC_KEY' | 'RUBRIC_TERMS' | 'CODE_TESTS' | 'EXAMINER';

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
    else if (b.kind === 'final' && b.content && typeof (b.content as { text?: unknown }).text === 'string') parts.push((b.content as { text: string }).text);
    else if (b.kind === 'canvas' && b.content && typeof b.content === 'object') {
      const strokes = ((b.content as { strokes?: Array<{ text?: unknown }> }).strokes ?? []) as Array<{ text?: unknown }>;
      if (strokes.length) hasDrawing = true;
      for (const s of strokes) if (typeof s.text === 'string') parts.push(s.text);
    }
  }
  return { text: parts.join('\n').trim(), hasDrawing };
}

/** The structured parts of an answer: the option(s) chosen, the typed final answer, the program. */
export function answerParts(content: unknown): { selected: string[] | null; final: string | null; code: { language: string; source: string } | null } {
  const blocks = ((content as { blocks?: Array<{ kind?: string; content?: unknown }> } | null)?.blocks ?? []) as Array<{ kind?: string; content?: unknown }>;
  let selected: string[] | null = null;
  let final: string | null = null;
  let code: { language: string; source: string } | null = null;
  for (const b of blocks) {
    const c = b.content as Record<string, unknown> | null;
    if (b.kind === 'choice' && c) {
      const v = c['selected'];
      selected = v === null || v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((x) => String(x).toUpperCase());
    } else if (b.kind === 'final' && c && typeof c['text'] === 'string' && c['text'].trim()) final = c['text'].trim();
    else if (b.kind === 'code' && c && typeof c['source'] === 'string' && c['source'].trim()) code = { language: String(c['language']), source: c['source'] };
  }
  return { selected, final, code };
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

function mcq(q: PaperQuestionRow, text: string, max: number, selected: string[] | null = null): MarkProposal | null {
  const keys = (Array.isArray(q.expected_answer) ? q.expected_answer : [q.expected_answer]).filter((k): k is string => typeof k === 'string' && k.trim() !== '').map((k) => k.trim().toUpperCase());
  const options = (Array.isArray(q.options) ? q.options : []) as Array<{ key: string; text: string }>;
  if (!keys.length || !options.length) return null;
  if (selected && selected.length) {
    // the student picked with the option buttons: no reading of text needed
    const base = { questionId: q.question_id, maxMarks: max, method: 'ANSWER_KEY' as const };
    if (selected.length > 1) return { ...base, proposedMarks: 0, basis: `More than one option chosen (${selected.join(', ')}); one answer is expected. Key: ${keys.join(' or ')}.` };
    return keys.includes(selected[0]!) ? { ...base, proposedMarks: max, basis: `Chose ${selected[0]}, which is the answer key.` } : { ...base, proposedMarks: 0, basis: `Chose ${selected[0]}; the answer key is ${keys.join(' or ')}.` };
  }
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


function rubricTerms(q: PaperQuestionRow, text: string, max: number): MarkProposal | null {
  const rubric = (Array.isArray(q.rubric) ? q.rubric : []) as Array<{ code: string; max: number; description: string; keywords?: string[]; difficulty?: number; critical?: boolean }>;
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
  // "Must not miss" steps (a red-flag symptom, a safe dose, a safety check): missing one means no proposed marks for
  // the question — the examiner reads it with a warning and decides.
  const missedCritical = rubric.filter((c, i) => c.critical && criteria[i]!.awarded === 0).map((c) => c.code);
  if (missedCritical.length) {
    return {
      questionId: q.question_id,
      maxMarks: max,
      proposedMarks: 0,
      method: 'RUBRIC_TERMS',
      review: 'CHECK_CAREFULLY',
      basis: `Must-not-miss step ${missedCritical.join(', ')} is missing, so the system proposes 0 and flags the answer. The examiner reads it and decides; other steps found would have earned ${total}.`,
      criteria,
    };
  }
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

/**
 * MCQ_MULTI: several correct options. Credit = correct chosen / all correct − wrong chosen / all wrong, never below
 * zero (no negative marking): ticking every option earns nothing, a partly right selection earns partly.
 */
function mcqMulti(q: PaperQuestionRow, max: number, selected: string[] | null): MarkProposal | null {
  const keys = (Array.isArray(q.expected_answer) ? q.expected_answer : [q.expected_answer]).filter((k): k is string => typeof k === 'string').map((k) => k.trim().toUpperCase());
  const options = ((Array.isArray(q.options) ? q.options : []) as Array<{ key: string }>).map((o) => String(o.key).toUpperCase());
  if (!keys.length || !options.length) return null;
  if (!selected || !selected.length) return { questionId: q.question_id, maxMarks: max, proposedMarks: 0, method: 'ANSWER_KEY', basis: 'No option chosen.' };
  const wrongOptions = options.filter((o) => !keys.includes(o));
  const right = selected.filter((x) => keys.includes(x)).length;
  const wrong = selected.filter((x) => !keys.includes(x)).length;
  const credit = Math.max(0, right / keys.length - (wrongOptions.length ? wrong / wrongOptions.length : 0));
  const marks = Math.min(max, nearestHalf(max * credit));
  return {
    questionId: q.question_id,
    maxMarks: max,
    proposedMarks: marks,
    method: 'ANSWER_KEY',
    review: marks > 0 && marks < max ? 'CHECK_CAREFULLY' : 'ROUTINE',
    basis: `Chose ${selected.join(', ')}; correct options are ${keys.join(', ')}. ${right} of ${keys.length} correct chosen, ${wrong} wrong chosen. Partial credit, never below zero.`,
  };
}

interface AnswerSpec {
  answerMarks?: number;
  unit?: string;
}

/** Answer marks from the key; method marks follow a right answer, otherwise the examiner judges the working. */
function withMethodMarks(q: PaperQuestionRow, max: number, method: ProposalMethod, correctShare: number, answerBasis: string, spec: AnswerSpec): MarkProposal {
  const answerMarks = typeof spec.answerMarks === 'number' && spec.answerMarks > 0 && spec.answerMarks <= max ? spec.answerMarks : max;
  const methodMarks = Math.round((max - answerMarks) * 100) / 100;
  const answerAwarded = nearestHalf(answerMarks * correctShare);
  if (methodMarks > 0 && correctShare < 1) {
    return { questionId: q.question_id, maxMarks: max, proposedMarks: null, method: 'EXAMINER', review: 'CHECK_CAREFULLY', basis: `${answerBasis} Answer marks ${answerAwarded} of ${answerMarks}. The ${methodMarks} method marks need the examiner: read the working (an error carried forward is not punished twice).` };
  }
  return { questionId: q.question_id, maxMarks: max, proposedMarks: Math.min(max, answerAwarded + (correctShare >= 1 ? methodMarks : 0)), method, review: correctShare > 0 && correctShare < 1 ? 'CHECK_CAREFULLY' : 'ROUTINE', basis: methodMarks > 0 ? `${answerBasis} Right answer: method marks follow.` : answerBasis };
}

/** A number counts only with the expected unit when the key names one (a dose in mg is not a dose in g). */
function unitOk(text: string, numberIndex: number, numberLength: number, unit: string | undefined): boolean {
  if (!unit) return true;
  const after = text.slice(numberIndex + numberLength, numberIndex + numberLength + 24).trim().toLowerCase();
  return after.startsWith(unit.toLowerCase());
}

function numericKeyed(q: PaperQuestionRow, text: string, max: number): MarkProposal | null {
  const ea = q.expected_answer;
  let values: number[] = [];
  let tolerance: number | null = null;
  let spec: AnswerSpec = {};
  if (typeof ea === 'number') values = [ea];
  else if (Array.isArray(ea)) values = ea.filter((v): v is number => typeof v === 'number');
  else if (ea && typeof ea === 'object') {
    const o = ea as { values?: unknown; value?: unknown; tolerance?: unknown; unit?: unknown; answerMarks?: unknown };
    values = (Array.isArray(o.values) ? o.values : [o.value]).filter((v): v is number => typeof v === 'number');
    tolerance = typeof o.tolerance === 'number' ? o.tolerance : null;
    spec = { unit: typeof o.unit === 'string' && o.unit.trim() ? o.unit.trim() : undefined, answerMarks: typeof o.answerMarks === 'number' ? o.answerMarks : undefined };
  }
  if (!values.length) return null;
  const clean = text.replace(/(\d),(\d{3})/g, '$1$2');
  const found = [...clean.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => ({ n: Number(m[0]), at: m.index ?? 0, len: m[0].length }));
  const tol = (v: number) => tolerance ?? Math.max(0.01, Math.abs(v) * 0.01);
  let unitMiss = 0;
  const hits = values.map((v) => {
    const near = found.filter((f) => Math.abs(f.n - v) <= tol(v));
    if (!near.length) return false;
    if (near.some((f) => unitOk(clean, f.at, f.len, spec.unit))) return true;
    unitMiss++;
    return false;
  });
  const n = hits.filter(Boolean).length;
  const basis = `${n} of ${values.length} expected ${values.length === 1 ? 'value' : 'values'} found (${values.map((v, i) => `${v}${spec.unit ? ` ${spec.unit}` : ''}${hits[i] ? ' ✓' : ' ✗'}`).join(', ')}; tolerance ${tolerance ?? '1 %'}).${unitMiss ? ` ${unitMiss} right number${unitMiss > 1 ? 's' : ''} without the unit ${spec.unit}: no credit for those.` : ''}`;
  return withMethodMarks(q, max, 'NUMERIC_KEY', n / values.length, basis, spec);
}

/** MATH: the final answer must be mathematically equivalent to the key (or one of its accepted forms). */
function mathKeyed(q: PaperQuestionRow, finalText: string | null, text: string, max: number): MarkProposal | null {
  const ea = q.expected_answer as { expression?: unknown; accepted?: unknown; answerMarks?: unknown } | string | null;
  const forms = typeof ea === 'string' ? [ea] : ea && typeof ea === 'object' ? [ea.expression, ...(Array.isArray(ea.accepted) ? ea.accepted : [])].filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
  if (!forms.length) return null;
  const spec: AnswerSpec = ea && typeof ea === 'object' && typeof ea.answerMarks === 'number' ? { answerMarks: ea.answerMarks } : {};
  const candidate = finalText ?? text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const answer = candidate.replace(/^.*=\s*/, ''); // "y = 2x+2" → "2x+2"
  const ok = forms.some((f) => equivalent(answer, f.replace(/^.*=\s*/, '')));
  return withMethodMarks(q, max, 'ANSWER_KEY', ok ? 1 : 0, ok ? `Final answer "${candidate}" is equivalent to the key.` : `Final answer "${candidate || '(none)'}" is not equivalent to the key ${forms[0]}.`, spec);
}

/** CODE: share of the hidden tests' weight the program passed in the sandbox. */
function codeGraded(q: PaperQuestionRow, max: number, run: CodeRunSummary | undefined): MarkProposal {
  const base = { questionId: q.question_id, maxMarks: max };
  if (!run) return { ...base, proposedMarks: null, method: 'EXAMINER', basis: 'The program has not been run against the tests yet; the examiner marks it, or re-runs the evaluation later.' };
  if (run.status !== 'DONE' || !run.totalWeight) return { ...base, proposedMarks: null, method: 'EXAMINER', review: 'CHECK_CAREFULLY', basis: `The judge could not run the program (${run.error ?? run.status}); the examiner marks it.` };
  const share = run.passedWeight / run.totalWeight;
  const failed = run.results.filter((r) => !r.passed);
  return {
    ...base,
    proposedMarks: Math.min(max, nearestHalf(max * share)),
    method: 'CODE_TESTS',
    review: share > 0 && share < 1 ? 'CHECK_CAREFULLY' : 'ROUTINE',
    basis: `${run.results.length - failed.length} of ${run.results.length} hidden tests passed (${Math.round(share * 100)} % of the test weight).${failed.length ? ` Failed: ${failed.slice(0, 5).map((r) => `test ${r.index + 1} (${r.verdict})`).join(', ')}${failed.length > 5 ? ', …' : ''}.` : ''} Code quality and approach are the examiner's judgement.`,
  };
}

export interface CodeRunSummary {
  status: 'QUEUED' | 'DONE' | 'ERROR';
  passedWeight: number;
  totalWeight: number;
  results: Array<{ index: number; passed: boolean; verdict: string }>;
  error?: string | null;
}

export function proposeMark(q: PaperQuestionRow, content: unknown, codeRun?: CodeRunSummary): MarkProposal {
  const max = Number(q.max_marks);
  const { text, hasDrawing } = answerText(content);
  const parts = answerParts(content);
  const empty = { questionId: q.question_id, maxMarks: max, proposedMarks: 0, method: 'NO_ANSWER' as const, basis: 'No answer was written.' };
  if (q.kind === 'CODE') return parts.code ? codeGraded(q, max, codeRun) : empty;
  if ((q.kind === 'MCQ' || q.kind === 'MCQ_MULTI') && parts.selected?.length) {
    const p = q.kind === 'MCQ' ? mcq(q, text, max, parts.selected) : mcqMulti(q, max, parts.selected);
    if (p) return p;
  }
  if (!text && !hasDrawing) return empty;
  const p =
    (q.kind === 'MCQ' ? mcq(q, text, max) : null) ??
    (q.kind === 'NUMERIC' ? numericKeyed(q, parts.final ?? text, max) : null) ??
    (q.kind === 'MATH' ? mathKeyed(q, parts.final, text, max) : null) ??
    (q.kind !== 'DRAWING' ? rubricTerms(q, text, max) : null);
  return p ?? { questionId: q.question_id, maxMarks: max, proposedMarks: null, method: 'EXAMINER', basis: q.kind === 'DRAWING' ? 'Drawings are marked by the examiner.' : 'No answer key or rubric key terms for this question; the examiner marks it.' };
}

/** Proposals for every question of the attempt's approved paper, or null when the exam has no approved paper. */
export async function proposeMarksForAttempt(trx: Knex.Transaction, tenantId: string, examId: string, attemptId: string): Promise<MarkProposal[] | null> {
  const paper = await trx('question_papers').where({ tenant_id: tenantId, exam_id: examId, status: 'APPROVED' }).first('id');
  if (!paper) return null;
  const questions = (await trx('paper_questions').where({ tenant_id: tenantId, paper_id: paper.id }).orderBy('number').select('question_id', 'kind', 'max_marks', 'options', 'rubric', 'expected_answer')) as PaperQuestionRow[];
  const docs = await trx('answer_documents').where({ tenant_id: tenantId, attempt_id: attemptId }).select('question_id', 'content');
  const byQ = new Map(docs.map((d) => [d.question_id as string, typeof d.content === 'string' ? JSON.parse(d.content) : d.content]));
  const runs = questions.some((q) => q.kind === 'CODE') ? await latestGradingRuns(trx, tenantId, attemptId) : new Map<string, CodeRunSummary>();
  return questions.map((q) => proposeMark(q, byQ.get(q.question_id) ?? { blocks: [] }, runs.get(q.question_id)));
}

/** The newest grading run per CODE question of an attempt. */
export async function latestGradingRuns(trx: Knex.Transaction, tenantId: string, attemptId: string): Promise<Map<string, CodeRunSummary>> {
  const rows = await trx('code_runs').where({ tenant_id: tenantId, attempt_id: attemptId, purpose: 'GRADING' }).orderBy('created_at', 'desc').select('question_id', 'status', 'results', 'passed_weight', 'total_weight', 'error');
  const out = new Map<string, CodeRunSummary>();
  for (const r of rows) {
    if (out.has(r.question_id)) continue;
    out.set(r.question_id, { status: r.status, passedWeight: Number(r.passed_weight ?? 0), totalWeight: Number(r.total_weight ?? 0), results: (r.results ?? []) as CodeRunSummary['results'], error: r.error });
  }
  return out;
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
