/**
 * Exam-day load smoke (Gate G rehearsal, single box).
 *
 * Provisions a `load` tenant with N students, takes them through readiness and
 * admission into a LIVE BASIC_BROWSER exam, then drives the real student mix
 * against a running API: heartbeat every 20 s, answer save every ~4 s, system
 * scan every 60 s. Reports latency percentiles per endpoint, errors by problem
 * code, database write volume and — the invariant that matters — whether any
 * attempt timeline hash chain forked under concurrency.
 *
 *   API:   set -a; . ./.env; set +a; npx tsx apps/api/src/server.ts
 *   Load:  npx tsx apps/api/scripts/load-smoke.ts --students 300 --seconds 120 [--base http://127.0.0.1:4000] [--phase all|setup|run]
 *
 * State (tokens, attempt ids) is kept in --state (default: ./.load-state.json)
 * so `--phase run` can be repeated. Numbers from one laptop are indicative;
 * the point is to find contention, N+1s and broken invariants before Gate G.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import knex from 'knex';
import { canonicalJson } from '../src/lib/crypto.js';

// ---------- args / env ----------
function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
}
function loadDotEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of ['.env', '../../.env', '../.env']) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) out[m[1]!] = m[2]!.replace(/^"|"$/g, '');
    }
    break;
  }
  return out;
}
const ENV = { ...loadDotEnv(), ...process.env } as Record<string, string | undefined>;
const BASE = arg('base', 'http://127.0.0.1:4000');
const STUDENTS = Number(arg('students', '300'));
const SECONDS = Number(arg('seconds', '120'));
const SAVE_EVERY_MS = Number(arg('save-every', '4')) * 1000;
const PHASE = arg('phase', 'all');
const STATE_PATH = arg('state', '.load-state.json');
const PLATFORM_KEY = ENV['PLATFORM_BOOTSTRAP_KEY'] ?? '';
const ADMIN_URL = ENV['DATABASE_ADMIN_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5432/examos_dev';
const SLUG = 'load';
const PASSWORD = 'Load-Passw0rd!2026';
const SETUP_CONCURRENCY = Number(arg('setup-concurrency', '25'));

// ---------- http ----------
interface Res { status: number; json: any; ms: number }
async function call(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'ExamOS-LoadSmoke/1.0', ...(opts.headers ?? {}) };
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
    return { status: res.status, json, ms: performance.now() - t0 };
  } catch (e) {
    return { status: 0, json: { code: 'NETWORK', message: e instanceof Error ? e.message : String(e) }, ms: performance.now() - t0 };
  }
}
function must(r: Res, what: string): any {
  if (r.status < 200 || r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  return r.json;
}
async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  }));
  return out;
}
const sha = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');

// ---------- state ----------
interface Student { email: string; externalId: string; token: string; attemptId: string; device: string; ip: string }
const ipFor = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
interface State { tenantId: string; examId: string; examCode: string; adminToken: string; examcellToken: string; students: Student[]; questionIds: string[] }

// ---------- setup ----------
async function setup(): Promise<State> {
  const db = knex({ client: 'pg', connection: ADMIN_URL, pool: { min: 0, max: 4 } });
  const activationToken = async (tenantId: string, email: string): Promise<string | null> => {
    const row = await db('mail_dispatches').where({ tenant_id: tenantId, category: 'ACCOUNT_ACTIVATION', to_address: email }).orderBy('created_at', 'desc').first('body_text');
    const m = row ? /token=([^\s]+)/.exec(row.body_text) : null;
    return m ? decodeURIComponent(m[1]!) : null;
  };
  const signIn = async (tenantId: string, email: string, ip?: string): Promise<string> => {
    const headers: Record<string, string> = ip ? { 'x-forwarded-for': ip } : {};
    const tok = await activationToken(tenantId, email);
    if (tok) {
      const act = await call('POST', '/auth/activate', { headers, body: { token: tok, password: PASSWORD } });
      if (act.status === 200) return act.json.accessToken;
    }
    const login = await call('POST', '/auth/login', { headers, body: { email, password: PASSWORD } });
    return must(login, `login ${email}`).accessToken;
  };

  // tenant (idempotent)
  let tenantId: string;
  const existing = await db('tenants').where({ slug: SLUG }).first('id');
  if (existing) tenantId = existing.id;
  else {
    const prov = must(await call('POST', '/platform/tenants', { headers: { 'x-platform-key': PLATFORM_KEY }, body: { slug: SLUG, name: 'Load University', domains: ['127.0.0.1'], adminEmail: `admin@${SLUG}.test`, adminFullName: 'Load Admin' } }), 'provision tenant');
    tenantId = prov.tenantId;
  }
  const adminToken = await signIn(tenantId, `admin@${SLUG}.test`);
  const A = { token: adminToken };
  must(await call('PUT', '/tenant/mail-config', { ...A, body: { transportKind: 'capture', senderAddress: `exam@${SLUG}.test`, senderName: 'Exam Cell (load)' } }), 'mail config');

  // staff: EXAM_OFFICE (conduct + papers) and CHIEF_REVIEWER (paper approval)
  const staffTokens: Record<string, string> = {};
  for (const [email, bundle, name] of [[`examcell@${SLUG}.test`, 'EXAM_OFFICE', 'Exam Office'], [`chief@${SLUG}.test`, 'CHIEF_REVIEWER', 'Chief Reviewer']] as const) {
    const u = await db('users').where({ tenant_id: tenantId, email }).first('id');
    if (!u) must(await call('POST', '/tenant/users', { ...A, body: { email, fullName: name, kind: 'STAFF', bundle, roles: [] } }), `create ${email}`);
    staffTokens[email] = await signIn(tenantId, email);
  }
  const E = { token: staffTokens[`examcell@${SLUG}.test`]! };
  const R = { token: staffTokens[`chief@${SLUG}.test`]! };

  // roster
  const key = must(await call('POST', '/tenant/api-keys', { ...A, body: { label: `load-${Date.now()}`, scopes: ['roster:write', 'roster:read'] } }), 'api key').apiKey as string;
  const K = (p: string, rows: unknown[]) => call('PUT', `/integration/v1/roster/${p}/batch`, { headers: { authorization: `Bearer ${key}`, 'idempotency-key': randomUUID(), 'x-examos-provider': 'uos' }, body: { rows } });
  must(await K('academic-units', [{ kind: 'DEPARTMENT', code: 'LD', name: 'Load Department' }]), 'units');
  must(await K('courses', [{ code: 'LD101', name: 'Load Course', departmentCode: 'LD' }]), 'courses');
  const people = Array.from({ length: STUDENTS }, (_, i) => ({ externalId: `LOAD-${String(i + 1).padStart(5, '0')}`, kind: 'STUDENT' as const, fullName: `Load Student ${i + 1}`, email: `s${String(i + 1).padStart(5, '0')}@${SLUG}.test` }));
  for (let i = 0; i < people.length; i += 500) {
    must(await K('persons', people.slice(i, i + 500)), `persons ${i}`);
    must(await K('enrollments', people.slice(i, i + 500).map((s) => ({ studentExternalId: s.externalId, courseCode: 'LD101', academicYear: '2026-27', term: 'ODD' }))), `enrollments ${i}`);
  }
  console.log(`roster: ${people.length} students`);
  const t1 = performance.now();
  const tokens = await pool(people, SETUP_CONCURRENCY, (p, i) => signIn(tenantId, p.email, ipFor(i + 1)));
  console.log(`activated/logged in ${tokens.length} students in ${((performance.now() - t1) / 1000).toFixed(1)} s`);

  // exam + paper
  const examCode = `LOAD-${Date.now().toString(36).toUpperCase()}`;
  const exam = must(await call('POST', '/exams', { ...E, body: { code: examCode, title: 'Load Rehearsal — 4 h', courseCode: 'LD101', examType: 'MID_1', academicYear: '2026-27', semester: 1, securityProfile: 'BASIC_BROWSER', durationMinutes: 240, windowStartAt: new Date(Date.now() - 60_000).toISOString(), windowEndAt: new Date(Date.now() + 6 * 3600_000).toISOString(), policy: { ipPolicy: 'REVIEW' } } }), 'create exam');
  const examId = exam.examId as string;
  const questionIds = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'];
  must(await call('PUT', `/exams/${examId}/paper`, { ...E, body: { title: 'Load paper', sections: [{ code: 'A', title: 'Section A' }], questions: questionIds.map((q, i) => ({ questionId: q, sectionCode: 'A', number: i + 1, kind: 'DESCRIPTIVE', prompt: { blocks: [{ id: `p${i}`, kind: 'paragraph', content: `Question ${i + 1}: explain.` }] }, maxMarks: 10, attachments: [] })) } }), 'paper');
  must(await call('POST', `/exams/${examId}/paper/submit-for-review`, E), 'paper submit');
  must(await call('POST', `/exams/${examId}/paper/approve`, R), 'paper approve');
  const t2 = performance.now();
  must(await call('POST', `/exams/${examId}/allocations`, { ...E, body: { studentExternalIds: people.map((p) => p.externalId), provider: 'uos' } }), 'allocations');
  console.log(`allocated in ${((performance.now() - t2) / 1000).toFixed(1)} s`);
  for (const step of ['submit-for-review', 'approve', 'schedule', 'open-precheck']) must(await call('POST', `/exams/${examId}/${step}`, E), step);

  // readiness per student
  const t3 = performance.now();
  const readiness = await pool(people, SETUP_CONCURRENCY, async (p, i) => {
    const token = tokens[i]!;
    const hdr = { 'x-forwarded-for': ipFor(i + 1) };
    const mine = must(await call('GET', '/student/me/exams', { token, headers: hdr }), 'me/exams');
    const attemptId = (mine.exams as Array<{ code: string; attemptId: string }>).find((e) => e.code === examCode)!.attemptId;
    const run = must(await call('POST', `/student/attempts/${attemptId}/prechecks`, { token, headers: hdr, body: { clientBuild: 'chrome-130' } }), 'precheck');
    const v = (body: unknown) => call('POST', `/student/prechecks/${run.runId}/items/verify`, { token, headers: hdr, body });
    must(await v({ code: 'CLOCK_SYNC', clientClockMs: Date.now() }), 'clock');
    must(await v({ code: 'KEYBOARD_INPUT', keyboardSample: 'The quick brown fox, 2026; jumps (over) the lazy dog!' }), 'keyboard');
    must(await v({ code: 'SYSTEM_SCAN', scan: cleanScan() }), 'scan');
    must(await call('POST', `/student/prechecks/${run.runId}/practice-saves`, { token, headers: hdr, body: { contentDigest: 'a'.repeat(64) } }), 'practice save');
    must(await v({ code: 'NETWORK_SAVE_ROUNDTRIP' }), 'network');
    const fin = must(await call('POST', `/student/prechecks/${run.runId}/finalize`, { token, headers: hdr }), 'finalize');
    if (fin.status !== 'READY') throw new Error(`student ${p.email} not READY: ${JSON.stringify(fin.checks)}`);
    return attemptId;
  });
  console.log(`readiness for ${readiness.length} students in ${((performance.now() - t3) / 1000).toFixed(1)} s`);

  must(await call('POST', `/exams/${examId}/start`, E), 'start exam');
  // admission burst: everyone presses Enter at once
  const t4 = performance.now();
  const admitMs: number[] = [];
  const students = await pool(people, SETUP_CONCURRENCY * 2, async (p, i): Promise<Student> => {
    const token = tokens[i]!;
    const hdr = { 'x-forwarded-for': ipFor(i + 1) };
    const g = must(await call('POST', `/student/attempts/${readiness[i]}/entry-grants`, { token, headers: hdr }), 'grant');
    const a = await call('POST', `/student/attempts/${readiness[i]}/admit`, { token, headers: hdr, body: { grantToken: g.grantToken } });
    admitMs.push(a.ms);
    must(a, 'admit');
    return { email: p.email, externalId: p.externalId, token, attemptId: readiness[i]!, device: a.json.deviceSessionId, ip: ipFor(i + 1) };
  });
  console.log(`admitted ${students.length} students in ${((performance.now() - t4) / 1000).toFixed(1)} s — admit ${pct(admitMs)}`);
  await db.destroy();
  const state: State = { tenantId, examId, examCode, adminToken, examcellToken: E.token, students, questionIds };
  writeFileSync(STATE_PATH, JSON.stringify(state));
  return state;
}

function cleanScan() {
  return {
    takenAt: new Date().toISOString(), userAgent: 'Mozilla/5.0 LoadSmoke', platform: 'Win32', language: 'en-IN', timezone: 'Asia/Kolkata',
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelRatio: 1, isExtended: false, displayCount: 1 },
    window: { innerWidth: 1920, innerHeight: 960, outerWidth: 1920, outerHeight: 1040 },
    hardware: { cores: 8, memoryGb: 8, touchPoints: 0, pointerFine: true }, gpu: { vendor: 'Intel', renderer: 'Intel(R) UHD Graphics 620' },
    browser: { webdriver: false, cookiesEnabled: true, fullscreenSupported: true, pdfViewer: true, pluginsCount: 5, displayCaptureActive: false, devtoolsHeuristic: false },
    network: { effectiveType: '4g', downlinkMbps: 10, rttMs: 50, online: true }, battery: { level: 0.9, charging: true }, visibility: 'visible',
  };
}

// ---------- run ----------
function pct(arr: number[]): string {
  if (!arr.length) return 'n=0';
  const s = [...arr].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!.toFixed(0);
  return `n=${s.length} p50=${q(0.5)}ms p95=${q(0.95)}ms p99=${q(0.99)}ms max=${s[s.length - 1]!.toFixed(0)}ms`;
}

async function dbSnapshot(db: knex.Knex) {
  const tables = ['answer_revisions', 'attempt_event_log', 'attempt_network_observations', 'device_scans', 'proctor_events', 'proctor_incidents', 'audit_events'];
  const rows = await db('pg_stat_user_tables').whereIn('relname', tables).select('relname', 'n_tup_ins', 'n_tup_upd', 'n_dead_tup');
  const xact = await db('pg_stat_database').where('datname', db.client.connectionSettings.database ?? 'examos_dev').first('xact_commit', 'xact_rollback', 'deadlocks');
  return { tables: Object.fromEntries(rows.map((r) => [r.relname, { ins: Number(r.n_tup_ins), upd: Number(r.n_tup_upd), dead: Number(r.n_dead_tup) }])), xact: { commit: Number(xact?.xact_commit ?? 0), rollback: Number(xact?.xact_rollback ?? 0), deadlocks: Number(xact?.deadlocks ?? 0) } };
}

async function run(state: State) {
  const db = knex({ client: 'pg', connection: ADMIN_URL, pool: { min: 0, max: 2 } });
  const before = await dbSnapshot(db);
  const metrics: Record<string, number[]> = { heartbeat: [], save: [], scan: [], resync: [] };
  const errors: Record<string, number> = {};
  const noteErr = (kind: string, r: Res) => { const k = `${kind}:${r.status}:${r.json?.code ?? '-'}`; errors[k] = (errors[k] ?? 0) + 1; };
  let maxBackends = 0;
  const backendSampler = setInterval(() => {
    db('pg_stat_activity').where('state', 'active').whereNot('backend_type', 'client backend').orWhere('state', 'active').count('* as n').first()
      .then((r) => { maxBackends = Math.max(maxBackends, Number((r as any)?.n ?? 0)); })
      .catch(() => undefined);
  }, 1000);

  interface VS { s: Student; text: Record<string, string>; rev: Record<string, number>; busy: Set<string>; nextHb: number; nextSave: number; nextScan: number; q: number }
  const now0 = Date.now();
  const vs: VS[] = state.students.map((s) => ({ s, text: {}, rev: {}, busy: new Set(), nextHb: now0 + Math.random() * 20_000, nextSave: now0 + Math.random() * SAVE_EVERY_MS, nextScan: now0 + Math.random() * 60_000, q: 0 }));
  const end = now0 + SECONDS * 1000;
  const SENTENCES = ['A process is a program in execution.', 'Deadlock needs mutual exclusion, hold and wait, no preemption and circular wait.', 'Paging removes external fragmentation.', 'The TLB caches page table entries.', 'Round robin uses a time quantum.'];

  const fire = (v: VS, kind: 'heartbeat' | 'save' | 'scan', fn: () => Promise<void>) => {
    if (v.busy.has(kind)) return; // never pile up the same request for one student
    v.busy.add(kind);
    fn().catch(() => undefined).finally(() => v.busy.delete(kind));
  };
  const heartbeat = (v: VS) => async () => {
    const r = await call('POST', `/student/attempts/${v.s.attemptId}/heartbeat`, { token: v.s.token, body: {}, headers: { 'x-device-session': v.s.device, 'x-forwarded-for': v.s.ip } });
    metrics.heartbeat!.push(r.ms);
    if (r.status !== 200) noteErr('heartbeat', r);
  };
  const scan = (v: VS) => async () => {
    const r = await call('POST', `/student/attempts/${v.s.attemptId}/device-scans`, { token: v.s.token, body: { scan: cleanScan() }, headers: { 'x-device-session': v.s.device, 'x-forwarded-for': v.s.ip } });
    metrics.scan!.push(r.ms);
    if (r.status !== 202) noteErr('scan', r);
  };
  const save = (v: VS) => async () => {
    const q = state.questionIds[v.q % state.questionIds.length]!;
    v.q++;
    if (v.rev[q] === undefined) {
      const g = await call('GET', `/student/attempts/${v.s.attemptId}/answers/${q}`, { token: v.s.token, headers: { 'x-forwarded-for': v.s.ip } });
      metrics.resync!.push(g.ms);
      if (g.status !== 200) { noteErr('load', g); return; }
      v.rev[q] = g.json.serverRevision;
      v.text[q] = (g.json.content?.blocks?.[0]?.content as string) ?? '';
    }
    const text = `${v.text[q] ?? ''}${v.text[q] ? ' ' : ''}${SENTENCES[v.q % SENTENCES.length]}`;
    const blocks = [{ id: 'b1', kind: 'paragraph', content: text }];
    const body = { clientOperationId: randomUUID(), baseRevision: v.rev[q], answerFormat: 'hybrid-v1', ops: [{ op: 'upsert-block', blockId: 'b1', kind: 'paragraph', content: text }], contentSha256: sha({ blocks }) };
    const r = await call('PUT', `/student/attempts/${v.s.attemptId}/answers/${q}`, { token: v.s.token, body, headers: { 'x-device-session': v.s.device, 'x-forwarded-for': v.s.ip } });
    metrics.save!.push(r.ms);
    if (r.status === 200) { v.rev[q] = r.json.serverRevision; v.text[q] = text; }
    else { noteErr('save', r); if (r.status === 409 || r.status === 422) delete v.rev[q]; }
  };

  console.log(`load: ${vs.length} students for ${SECONDS}s — heartbeat/20s, save/${SAVE_EVERY_MS / 1000}s, scan/60s`);
  const started = Date.now();
  while (Date.now() < end) {
    const t = Date.now();
    for (const v of vs) {
      if (t >= v.nextHb) { v.nextHb = t + 20_000; fire(v, 'heartbeat', heartbeat(v)); }
      if (t >= v.nextSave) { v.nextSave = t + SAVE_EVERY_MS * (0.8 + Math.random() * 0.4); fire(v, 'save', save(v)); }
      if (t >= v.nextScan) { v.nextScan = t + 60_000; fire(v, 'scan', scan(v)); }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  // drain
  await new Promise((r) => setTimeout(r, 3000));
  clearInterval(backendSampler);
  const elapsed = (Date.now() - started) / 1000;
  const after = await dbSnapshot(db);

  // invariants
  const forks = await db.raw(`select count(*)::int as n from (select attempt_id, prev_hash from attempt_event_log where tenant_id = ? and prev_hash is not null group by 1,2 having count(*) > 1) f`, [state.tenantId]);
  const auditForks = await db.raw(`select count(*)::int as n from (select prev_hash from audit_events where tenant_id = ? and prev_hash is not null group by 1 having count(*) > 1) f`, [state.tenantId]);
  const statuses = await db('exam_attempts').where({ exam_id: state.examId }).select('status').count('* as n').groupBy('status');
  await db.destroy();

  const total = Object.values(metrics).reduce((a, b) => a + b.length, 0);
  console.log(`\n=== results (${elapsed.toFixed(0)} s, ${total} requests, ${(total / elapsed).toFixed(1)} req/s, max active DB backends ${maxBackends}) ===`);
  for (const [k, arr] of Object.entries(metrics)) console.log(`${k.padEnd(10)} ${pct(arr)}  (${(arr.length / elapsed).toFixed(1)}/s)`);
  console.log('errors:', Object.keys(errors).length ? errors : 'none');
  console.log('attempt statuses:', statuses.map((s) => `${s.status}=${s.n}`).join(' '));
  console.log('db writes during run:');
  for (const t of Object.keys(after.tables)) {
    const a = after.tables[t]!, b = before.tables[t] ?? { ins: 0, upd: 0, dead: 0 };
    console.log(`  ${t.padEnd(30)} +${a.ins - b.ins} rows, ${a.upd - b.upd} updates`);
  }
  console.log(`  transactions: ${after.xact.commit - before.xact.commit} committed, ${after.xact.rollback - before.xact.rollback} rolled back, deadlocks +${after.xact.deadlocks - before.xact.deadlocks}`);
  console.log(`timeline chain forks: ${forks.rows[0].n}   audit chain forks: ${auditForks.rows[0].n}`);
}

async function main() {
  let state: State | null = null;
  if (PHASE === 'all' || PHASE === 'setup') state = await setup();
  else if (existsSync(STATE_PATH)) state = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as State;
  if (!state) throw new Error('no state; run --phase setup first');
  if (PHASE === 'all' || PHASE === 'run') await run(state);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
