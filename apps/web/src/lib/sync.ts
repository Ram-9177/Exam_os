import { ApiError } from './api';
import { blockHasContent, buildOps, contentHash, docsEqual, wireDoc, type AnswerDoc, type AnswerOp, EMPTY_DOC } from './answers';
import { uuid } from './ids';

/**
 * Per-attempt answer synchronisation (spec §7 save & recovery contract).
 *
 * - every edit is kept locally first (memory + sessionStorage), so a network
 *   drop never loses typing;
 * - saves are debounced (3 s) with an upper bound (15 s);
 * - each save carries baseRevision + a clientOperationId; a retry of the same
 *   save reuses the same id, so duplicates are harmless;
 * - 409 REVISION_CONFLICT / 422 CONTENT_HASH_MISMATCH reload the server
 *   document and re-express the local draft against it (rebase);
 * - failing for longer than 30 s is surfaced as "Recovery needed".
 */
export interface AnswerSaveBody {
  clientOperationId: string;
  baseRevision: number;
  answerFormat: 'hybrid-v1';
  ops: AnswerOp[];
  contentSha256: string;
}
export interface AnswerSaveResponse {
  accepted: true;
  serverRevision: number;
  receiptId: string;
  serverSavedAt: string;
  contentSha256: string;
  duplicate: boolean;
}
export interface AnswerLoadResponse {
  questionId: string;
  serverRevision: number;
  content: AnswerDoc;
  contentSha256: string;
}

export interface SyncTransport {
  save(questionId: string, body: AnswerSaveBody): Promise<AnswerSaveResponse>;
  load(questionId: string): Promise<AnswerLoadResponse>;
}

export type QuestionSyncState = 'empty' | 'saved-local' | 'syncing' | 'saved-server' | 'recovery' | 'paused';

interface Inflight {
  clientOperationId: string;
  baseRevision: number;
  ops: AnswerOp[];
  contentSha256: string;
  target: AnswerDoc;
}

interface QuestionRecord {
  questionId: string;
  loaded: boolean;
  serverRevision: number;
  serverDoc: AnswerDoc;
  localDoc: AnswerDoc;
  dirty: boolean;
  dirtySince: number | null;
  inflight: Inflight | null;
  /** A save that failed for a transport reason and will be retried verbatim (same clientOperationId). */
  retry: Inflight | null;
  lastSavedAt: number | null;
  lastReceiptId: string | null;
  failingSince: number | null;
  lastErrorCode: string | null;
  /** Consecutive transport failures / rebases, for exponential back-off. */
  transportFailures: number;
  rebaseFailures: number;
}

export interface QuestionSnapshot {
  questionId: string;
  state: QuestionSyncState;
  serverRevision: number;
  localDoc: AnswerDoc;
  lastSavedAt: number | null;
  answered: boolean;
}
export interface SyncSnapshot {
  overall: QuestionSyncState;
  questions: Record<string, QuestionSnapshot>;
  unsynced: string[];
  paused: boolean;
  pauseReason: string | null;
}

export interface SyncOptions {
  attemptId: string;
  transport: SyncTransport;
  debounceMs?: number;
  maxWaitMs?: number;
  retryMs?: number;
  recoveryAfterMs?: number;
  /** Source of back-off jitter in [0, 1); tests pin it. */
  jitter?: () => number;
  now?: () => number;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** Called with codes that stop syncing: ATTEMPT_NOT_ACTIVE, DEVICE_SESSION_MISMATCH, DEADLINE_PASSED. */
  onBlocked?: (code: string) => void;
}

const BLOCKING_CODES = new Set(['ATTEMPT_NOT_ACTIVE', 'DEVICE_SESSION_MISMATCH', 'DEADLINE_PASSED', 'ALREADY_SUBMITTED', 'ATTEMPT_STATE', 'NETWORK_ADDRESS_LOCKED', 'NETWORK_NOT_ALLOWED']);
const REBASE_CODES = new Set(['REVISION_CONFLICT', 'CONTENT_HASH_MISMATCH']);
/** The server refused the content itself; resending it verbatim cannot help. The draft is kept and shown as needing attention until the student edits it. */
const ATTENTION_CODES = new Set(['PAYLOAD_TOO_LARGE', 'ANSWER_TOO_LARGE', 'ANSWER_INVALID', 'VALIDATION', 'INVALID_QUESTION_ID']);
const MAX_REBASE_RETRIES = 3;
const MAX_RETRY_MS = 60_000;
const MAX_PERSIST_BYTES = 1_500_000;

export class AnswerSync {
  private readonly records = new Map<string, QuestionRecord>();
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly maxTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();
  private snapshot: SyncSnapshot | null = null;
  private paused = false;
  private pauseReason: string | null = null;
  private readonly opts: Required<Pick<SyncOptions, 'debounceMs' | 'maxWaitMs' | 'retryMs' | 'recoveryAfterMs' | 'now'>> & SyncOptions;
  private readonly storageKey: string;
  /** Questions whose unsaved draft was restored from this device's storage when the workspace opened. */
  private readonly restoredIds: string[] = [];
  private disposed = false;
  private readonly loads = new Map<string, Promise<void>>();
  private readonly saves = new Map<string, Promise<void>>();

  constructor(options: SyncOptions) {
    this.opts = { debounceMs: 3000, maxWaitMs: 15000, retryMs: 5000, recoveryAfterMs: 30000, now: () => Date.now(), ...options };
    this.storageKey = `examos.draft.${options.attemptId}`;
    this.restore();
  }

  // ---------- subscription (useSyncExternalStore) ----------
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SyncSnapshot => {
    if (!this.snapshot) this.snapshot = this.computeSnapshot();
    return this.snapshot;
  };

  private changed(): void {
    this.snapshot = null;
    for (const l of [...this.listeners]) l();
  }

  private computeSnapshot(): SyncSnapshot {
    const now = this.opts.now();
    const questions: Record<string, QuestionSnapshot> = {};
    let overall: QuestionSyncState = 'saved-server';
    let anyLocal = false;
    let anySyncing = false;
    let anyRecovery = false;
    const unsynced: string[] = [];
    for (const r of this.records.values()) {
      const state = this.stateOf(r, now);
      questions[r.questionId] = { questionId: r.questionId, state, serverRevision: r.serverRevision, localDoc: r.localDoc, lastSavedAt: r.lastSavedAt, answered: r.localDoc.blocks.some(blockHasContent) };
      if (r.dirty || r.inflight || r.retry) unsynced.push(r.questionId);
      if (state === 'recovery') anyRecovery = true;
      else if (state === 'syncing') anySyncing = true;
      else if (state === 'saved-local') anyLocal = true;
    }
    if (this.paused) overall = 'paused';
    else if (anyRecovery) overall = 'recovery';
    else if (anySyncing) overall = 'syncing';
    else if (anyLocal) overall = 'saved-local';
    return { overall, questions, unsynced, paused: this.paused, pauseReason: this.pauseReason };
  }

  private stateOf(r: QuestionRecord, now: number): QuestionSyncState {
    if (this.paused && (r.dirty || r.inflight || r.retry)) return 'paused';
    if (r.failingSince !== null && now - r.failingSince >= this.opts.recoveryAfterMs) return 'recovery';
    if (r.inflight) return 'syncing';
    if (r.dirty || r.retry) return 'saved-local';
    if (!r.loaded && r.localDoc.blocks.length === 0) return 'empty';
    return 'saved-server';
  }

  // ---------- records ----------
  private record(questionId: string): QuestionRecord {
    let r = this.records.get(questionId);
    if (!r) {
      r = { questionId, loaded: false, serverRevision: 0, serverDoc: EMPTY_DOC, localDoc: EMPTY_DOC, dirty: false, dirtySince: null, inflight: null, retry: null, lastSavedAt: null, lastReceiptId: null, failingSince: null, lastErrorCode: null, transportFailures: 0, rebaseFailures: 0 };
      this.records.set(questionId, r);
    }
    return r;
  }

  /** Server truth for a question (after reconnect, or on first open). Keeps an unsynced local draft and rebases it. */
  load(questionId: string): Promise<void> {
    const pending = this.loads.get(questionId);
    if (pending) return pending;
    const task = this.loadQuestion(questionId).finally(() => this.loads.delete(questionId));
    this.loads.set(questionId, task);
    return task;
  }

  private async loadQuestion(questionId: string): Promise<void> {
    const r = this.record(questionId);
    const fresh = await this.opts.transport.load(questionId);
    r.serverRevision = fresh.serverRevision;
    r.serverDoc = fresh.content ?? EMPTY_DOC;
    r.loaded = true;
    if (!r.dirty && !r.retry && !r.inflight) r.localDoc = r.serverDoc;
    else if (docsEqual(r.localDoc, r.serverDoc)) {
      r.dirty = false;
      r.retry = null;
      r.dirtySince = null;
    }
    this.changed();
    if (r.dirty || r.retry) this.scheduleFlush(questionId, 0);
  }

  /** Adopt revisions reported by reconnect without a per-question fetch; a mismatch marks the record unloaded. */
  noteServerRevision(questionId: string, serverRevision: number, contentSha256: string, localHash?: string): void {
    const r = this.record(questionId);
    if (r.serverRevision !== serverRevision || (localHash && localHash !== contentSha256)) r.loaded = false;
    this.changed();
  }

  getDoc(questionId: string): AnswerDoc {
    return this.record(questionId).localDoc;
  }

  isLoaded(questionId: string): boolean {
    return this.record(questionId).loaded;
  }

  edit(questionId: string, doc: AnswerDoc): void {
    const r = this.record(questionId);
    r.localDoc = doc;
    if (!r.dirty) {
      r.dirty = true;
      r.dirtySince = this.opts.now();
    }
    if (ATTENTION_CODES.has(r.lastErrorCode ?? '')) {
      // the student changed the refused content: try again from scratch
      r.lastErrorCode = null;
      r.failingSince = null;
    }
    this.persist(questionId);
    this.changed();
    this.scheduleFlush(questionId);
  }

  private scheduleFlush(questionId: string, delay: number = this.opts.debounceMs): void {
    if (this.disposed) return;
    const existing = this.debounceTimers.get(questionId);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      questionId,
      setTimeout(() => {
        this.debounceTimers.delete(questionId);
        void this.flush(questionId);
      }, delay),
    );
    if (!this.maxTimers.has(questionId)) {
      const r = this.record(questionId);
      const elapsed = r.dirtySince === null ? 0 : this.opts.now() - r.dirtySince;
      this.maxTimers.set(
        questionId,
        setTimeout(
          () => {
            this.maxTimers.delete(questionId);
            void this.flush(questionId);
          },
          Math.max(0, this.opts.maxWaitMs - elapsed),
        ),
      );
    }
  }

  private clearTimers(questionId: string): void {
    const d = this.debounceTimers.get(questionId);
    if (d) clearTimeout(d);
    this.debounceTimers.delete(questionId);
    const m = this.maxTimers.get(questionId);
    if (m) clearTimeout(m);
    this.maxTimers.delete(questionId);
  }

  /** Sends the pending draft of one question. Safe to call at any time. */
  flush(questionId: string): Promise<void> {
    const pending = this.saves.get(questionId);
    if (pending) return pending;
    const task = this.flushQuestion(questionId).finally(() => this.saves.delete(questionId));
    this.saves.set(questionId, task);
    return task;
  }

  private async flushQuestion(questionId: string): Promise<void> {
    const r = this.record(questionId);
    this.clearTimers(questionId);
    if (this.paused || this.disposed || r.inflight) return;

    let req: Inflight | null = r.retry;
    if (req) {
      r.retry = null;
    } else {
      if (!r.dirty) return;
      const ops = buildOps(r.serverDoc, r.localDoc);
      r.dirty = false;
      r.dirtySince = null;
      if (ops.length === 0) {
        this.changed();
        return;
      }
      const target = wireDoc(r.localDoc);
      req = { clientOperationId: uuid(), baseRevision: r.serverRevision, ops, contentSha256: '', target };
    }
    r.inflight = req;
    this.changed();
    try {
      // Reserve the in-flight slot before asynchronous hashing; concurrent
      // flushes and server loads must not overwrite the local draft here.
      if (!req.contentSha256) req.contentSha256 = await contentHash(req.target);
      const res = await this.opts.transport.save(questionId, { clientOperationId: req.clientOperationId, baseRevision: req.baseRevision, answerFormat: 'hybrid-v1', ops: req.ops, contentSha256: req.contentSha256 });
      r.serverRevision = res.serverRevision;
      r.serverDoc = req.target;
      r.loaded = true;
      r.lastSavedAt = this.opts.now();
      r.lastReceiptId = res.receiptId;
      r.failingSince = null;
      r.lastErrorCode = null;
      r.transportFailures = 0;
      r.rebaseFailures = 0;
      if (!r.dirty && !docsEqual(r.localDoc, r.serverDoc)) {
        // edits landed while the save was in flight
        r.dirty = true;
        r.dirtySince = this.opts.now();
      }
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'NETWORK';
      r.lastErrorCode = code;
      if (REBASE_CODES.has(code)) {
        r.rebaseFailures++;
        try {
          const fresh = await this.opts.transport.load(questionId);
          r.serverRevision = fresh.serverRevision;
          r.serverDoc = fresh.content ?? EMPTY_DOC;
          r.loaded = true;
        } catch {
          r.failingSince ??= this.opts.now();
        }
        // The local draft is still the intended document: rebase by rebuilding ops against the fresh base.
        r.dirty = true;
        r.dirtySince ??= this.opts.now();
        // A conflict that never resolves (two tabs editing) is shown as needing attention and slows down.
        if (r.rebaseFailures > MAX_REBASE_RETRIES) r.failingSince ??= this.opts.now() - this.opts.recoveryAfterMs;
      } else if (BLOCKING_CODES.has(code)) {
        r.retry = req;
        this.pause(code);
        this.opts.onBlocked?.(code);
      } else if (ATTENTION_CODES.has(code)) {
        r.dirty = true;
        r.dirtySince ??= this.opts.now();
        r.failingSince ??= this.opts.now() - this.opts.recoveryAfterMs;
      } else {
        // transport failure: retry the identical request later (idempotent by clientOperationId), backing off
        r.retry = req;
        r.transportFailures++;
        r.failingSince ??= this.opts.now();
      }
    } finally {
      r.inflight = null;
      this.persist(r.questionId);
      this.changed();
    }
    if (!this.paused && !this.disposed) {
      const code = r.lastErrorCode ?? '';
      if (r.retry) this.scheduleFlush(questionId, this.backoff(r.transportFailures));
      else if (r.dirty && ATTENTION_CODES.has(code)) return; // waits for the student's next edit
      else if (r.dirty && REBASE_CODES.has(code)) this.scheduleFlush(questionId, r.rebaseFailures > MAX_REBASE_RETRIES ? this.backoff(r.rebaseFailures - MAX_REBASE_RETRIES) : 0);
      else if (r.dirty) this.scheduleFlush(questionId, this.opts.debounceMs);
    }
  }

  /** retryMs, then doubling with jitter up to a minute: 2,000 clients never retry in lock-step after an outage. */
  private backoff(attempt: number): number {
    if (attempt <= 1) return this.opts.retryMs;
    const base = Math.min(MAX_RETRY_MS, this.opts.retryMs * 2 ** Math.min(attempt - 1, 4));
    return Math.round(base * (0.8 + (this.opts.jitter ?? Math.random)() * 0.4));
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.records.keys()].map((q) => this.flush(q)));
    // Edits made during a save need a second acknowledgement before sealing.
    await Promise.all([...this.records.values()].filter((r) => r.dirty && !r.retry).map((r) => this.flush(r.questionId)));
  }

  pause(reason: string): void {
    this.paused = true;
    this.pauseReason = reason;
    for (const q of this.records.keys()) this.clearTimers(q);
    this.changed();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.pauseReason = null;
    this.changed();
    for (const r of this.records.values()) if (r.dirty || r.retry) this.scheduleFlush(r.questionId, 0);
  }

  isPaused(): boolean {
    return this.paused;
  }

  unsyncedQuestionIds(): string[] {
    return [...this.records.values()].filter((r) => r.dirty || r.inflight || r.retry).map((r) => r.questionId);
  }

  // ---------- local persistence ----------
  // One storage entry per question (`<key>.<questionId>`): a drawing that outgrows the per-entry cap only loses its
  // own persistence, never the other answers'. The single-blob `<key>` format of earlier builds is still restored.
  private persist(questionId: string): void {
    const s = this.opts.storage === undefined ? safeSessionStorage() : this.opts.storage;
    if (!s) return;
    const r = this.records.get(questionId);
    if (!r) return;
    const key = `${this.storageKey}.${questionId}`;
    try {
      const json = JSON.stringify({ localDoc: wireDoc(r.localDoc), serverRevision: r.serverRevision, serverDoc: wireDoc(r.serverDoc), dirty: r.dirty || !!r.retry || !!r.inflight });
      if (json.length > MAX_PERSIST_BYTES) s.removeItem(key); // bounded: memory copy only for this question
      else s.setItem(key, json);
      const index = this.readIndex(s);
      if (!index.includes(questionId)) s.setItem(`${this.storageKey}.index`, JSON.stringify([...index, questionId]));
    } catch {
      /* quota or private mode: memory copy is still authoritative */
    }
  }

  private readIndex(s: Pick<Storage, 'getItem'>): string[] {
    try {
      const raw = s.getItem(`${this.storageKey}.index`);
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  private restoreRecord(questionId: string, v: { localDoc?: AnswerDoc; serverRevision?: number; serverDoc?: AnswerDoc; dirty?: boolean }): void {
    const r = this.record(questionId);
    r.localDoc = v.localDoc ?? EMPTY_DOC;
    r.serverDoc = v.serverDoc ?? EMPTY_DOC;
    r.serverRevision = v.serverRevision ?? 0;
    r.dirty = !!v.dirty;
    r.dirtySince = r.dirty ? this.opts.now() : null;
    if (r.dirty) this.restoredIds.push(questionId);
  }

  private restore(): void {
    const s = this.opts.storage === undefined ? safeSessionStorage() : this.opts.storage;
    if (!s) return;
    try {
      for (const questionId of this.readIndex(s)) {
        const raw = s.getItem(`${this.storageKey}.${questionId}`);
        if (raw) this.restoreRecord(questionId, JSON.parse(raw));
      }
      const legacy = s.getItem(this.storageKey);
      if (legacy) {
        const payload = JSON.parse(legacy) as Record<string, { localDoc: AnswerDoc; serverRevision: number; serverDoc: AnswerDoc; dirty: boolean }>;
        for (const [questionId, v] of Object.entries(payload)) if (!this.records.has(questionId)) this.restoreRecord(questionId, v);
      }
    } catch {
      /* ignore corrupt drafts */
    }
  }

  /** Drafts that were kept on this device and restored on open (after a reload, crash or browser restart). */
  restoredDraftIds(): readonly string[] {
    return this.restoredIds;
  }

  clearPersisted(): void {
    const s = this.opts.storage === undefined ? safeSessionStorage() : this.opts.storage;
    if (!s) return;
    try {
      for (const questionId of this.readIndex(s)) s.removeItem(`${this.storageKey}.${questionId}`);
      s.removeItem(`${this.storageKey}.index`);
      s.removeItem(this.storageKey);
    } catch {
      /* ignore */
    }
  }

  /** Re-arms a disposed engine (React StrictMode mounts, unmounts and mounts again with the same instance). */
  attach(): void {
    if (!this.disposed) return;
    this.disposed = false;
    for (const r of this.records.values()) if (!this.paused && (r.dirty || r.retry)) this.scheduleFlush(r.questionId, 0);
  }

  /** Stops timers; the in-memory and persisted drafts are kept so attach() can resume. */
  dispose(): void {
    this.disposed = true;
    for (const q of this.records.keys()) this.clearTimers(q);
  }
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}
