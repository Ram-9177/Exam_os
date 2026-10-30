# Exam-day audit — 2,000 students × 4 hours (2026-10-30)

**Question asked.** Is the codebase ready to sit 2,000+ students for a four-hour exam, and where does the logic break? Four independent code reviews (student hot path and scale, routes/tenancy/security, web client on exam day, post-exam/workers/docs) plus a single-box load rehearsal (`apps/api/scripts/load-smoke.ts`) against the code before and after the fixes.

**Answer in one paragraph.** The request path was never the problem: 300 students at the real mix cost ~108 req/s with p99 under 70 ms on one 4-vCPU box shared with PostgreSQL and the load generator. What would have failed on exam day was *correctness under concurrency* and *what happens when something goes wrong*: both tamper-evidence hash chains forked under ordinary load (1 timeline fork and 124 audit forks in 90 s — forensics would have reported innocent students as "chain broken"), closing a 2,000-seat exam sealed every attempt inside one transaction, nothing sealed a student whose own time ran out, a Redis restart would have moved every writing student to recovery, the client paused its own autosave forever after one refused write and logged students out on a 5xx during token renewal, and the server stored whatever a client called a drawing. All of those are fixed, tested and re-measured below. What remains open is listed with a priority and a concrete fix; none of it is on the student's path during the sitting, but several items (answer-key exposure before LIVE, evaluator scope, delta encoding of drawings, real-infrastructure load test) must be closed before a first real sitting.

Status honesty: everything below is *Tested* against the real database or *measured* on one machine; nothing is *Completed* (no university acceptance yet).

---

## 1. Measured: before and after (same harness, same box)

Single box: 4 vCPU / 15 GB, PostgreSQL 16, Redis 7, the API (one Node process, pool 20) and the load generator all on it. 300 virtual students, each: heartbeat every 20 s, save every ~4 s (text grows), system scan every 60 s. Setup phase goes through the real routes (activation, readiness, admission).

| | Before (commit `35342e5`) | After (commit `c0708d1`) |
|---|---|---|
| Admission burst (300 admits) | 3.3 s, p50 290 ms | 4.0 s, p50 401 ms (audit chain now serialised per tenant — expected) |
| Throughput / 90 s | 9,999 req, 107.5 req/s | 10,019 req, 107.7 req/s |
| Save latency | p50 24 ms · p95 43 ms · p99 56 ms | p50 24 ms · p95 44 ms · p99 64 ms |
| Heartbeat latency | p50 19 ms · p99 46 ms | p50 20 ms · p99 49 ms |
| Max active DB backends | 5 | 6 |
| Errors / rollbacks / deadlocks | 0 / 0 / 0 | 0 / 0 / 0 |
| `attempt_network_observations` updates | **8,079** (one per request) | **300** (once a minute per address) |
| **Timeline chain forks** | **1** | **0** (and impossible: unique tripwire index) |
| **Audit chain forks** | **124** | **0** (idem) |

Extrapolation, not measurement: 2,000 students ≈ 7× this mix ≈ 280–420 req/s steady state, 50,000 requests in the first two minutes of admission, ≈1,800 row writes/s at the top. The per-request cost measured here (≈10 SQL round trips per save, ≈7 per heartbeat, ≈2 transactions per request) is well inside what two API processes behind PgBouncer and a 4-vCPU PostgreSQL handle; the real Gate G test on the target infrastructure is still required (see §4).

**600 students × 120 s (after, same box):** 24,800 requests, 201.6 req/s, 0 errors, 0 rollbacks, 0 deadlocks, 0 chain forks; 600 admissions in 8.0 s (p99 1.16 s). Latency became bimodal: save p50 54 ms but p95 2.2 s / p99 2.5 s, with 21 active database backends — i.e. the single API process's pool of 20 connections was the queue, not PostgreSQL (which stayed well below its capacity) and not the lock design (zero waits in the log). The honest reading: **one API process with pool 20 serves ≈200 req/s at p50 ≈50 ms before it starts queueing**; 2,000 students (≈300–450 req/s steady, more at admission) need at least four processes — two nodes × two processes, or `DB_POOL_MAX` raised behind PgBouncer — exactly the topology `docs/deployment.md` prescribes, now with a measured per-process figure behind it. Every request still completed inside the 10 s acquire timeout; nothing returned `DB_BUSY`.

## 2. Fixed in this pass (all with tests)

| # | Severity | Area | What was wrong | Fix | Test |
|---|---|---|---|---|---|
| F1 | P0 integrity | Evidence | `logAttemptEvent`/`audit` read the chain tail and inserted without serialisation; concurrent heartbeats/scans/saves forked the chain; forensics then flagged the student | per-chain `pg_advisory_xact_lock` (`lib/locks.ts`, `lib/audit.ts`); migration 0102 unique tripwire indexes | scale-invariants (burst + 20 parallel logins), load run |
| F2 | P0 exam day (web) | Autosave | after `ATTEMPT_NOT_ACTIVE`/`DEADLINE_PASSED` the sync paused and only resumed on a *change* of session kind, which never came → "Paused" forever, cannot submit | resume on every heartbeat reporting ACTIVE; paused banner with "Try again" | exam-workspace tests; manual reasoning in ADR 0007 |
| F3 | P1 | Close | `transitionExam(CLOSED)` sealed every open attempt in one transaction (≈24,000 statements at 2,000 seats, all rows locked) | one UPDATE sets all deadlines; per-attempt sealing with inline budget + worker `seal-closed-exams` | scale-invariants, exam-flow |
| F4 | P1 | Deadline | nothing sealed a student whose own deadline passed; client's final flush was refused by construction; Submit disabled after local expiry | worker `deadline-sweep` (30 s grace, re-checked under lock); heartbeat carries the receipt; client flushes at T−10 s, keeps Submit, unlocks on extension | hardening, scale-invariants |
| F5 | P1 | Sweep | missing Redis key = "silent" → a flush/failover moved every ACTIVE student to RECOVERY_PENDING; O(N) sequential GETs in one transaction | one MGET; missing key seeds a fresh grace window; admit/reconnect seed it | scale-invariants |
| F6 | P1 security | Answers | `content` was `z.unknown()`; unbounded; SVG renderer interpolated raw point values (stored XSS into staff browsers and the PDF renderer) | `answer-validation.ts` (per-kind schema, ≤200 blocks / 4 MB); `num()` on every coordinate; one canonical string hashed and stored | hardening |
| F7 | P0 security | Secrets | tenant admins could store `env:JWT_PRIVATE_KEY_PEM` as a transport/SSO secret reference and have it sent to their own endpoint | `assertClientSuppliedRef`: tenant input may only carry `enc:` | hardening |
| F8 | P1 | Auth | any non-2xx on `/auth/refresh` (502/429) signed the student out; a lost rotation response revoked the whole family on retry | client: only 401/403 ends the session, else transient; server: one retry honoured inside 30 s, child revoked, family revoked on further reuse | api-refresh (web), scale-invariants, auth.test |
| F9 | P1 | Web | no request timeout (dead socket = "Syncing" forever); heartbeats stacked; no beat on wake-up; heartbeats continued after seal (incident spam on device-mismatch) | 15 s timeouts, single-flight heartbeat, beat on visibility/online/pageshow, stop when terminal | session/workspace |
| F10 | P1 | Web | retry storm on conflicts (rebase at network speed) and verbatim resend of refused content every 5 s with a toast each time | exponential back-off with jitter; rebases capped at 3 then recovery; refused content waits for the student's edit | sync-backoff |
| F11 | P1 ops | DB | `DB_POOL_MAX` dead config; 60 s acquire timeout; no lock/statement/idle timeouts; busy database → 500 | config threaded, 10 s acquire, role timeouts (0102), `503 DB_BUSY retryable` | errors.ts; load run |
| F12 | P1 | Lock order | three-way cycle possible (save → signal → decision) and the review signal took the chain lock before the incident lock | one order: incidents → timeline → audit; attempt row → incident row; ingest never locks the attempt row (nested refusal transactions) | scale-invariants burst (Postgres log clean of deadlocks) |
| F13 | P0 post-exam | Booklet | paper prompts are `{blocks}`; `BookletView` rendered the object (React crash on evaluator/student booklet), PDF printed `[object Object]` | `promptText()` in `@examos/contracts`, used by web and PDF | booklet render |
| F14 | P1 post-exam | Holds | `INTEGRITY_HOLD`/`IDENTITY_REVIEW_REQUIRED` placed before marks could never be released (illegal transition / dead end) | `FORENSIC_REVIEW_READY` added as a release target; any hold without marks steps back into marking | hardening |
| F15 | P1 post-exam | Forensics worker | one throwing packet aborted every pass for every tenant | per-packet try/catch; failing packet → `TECHNICAL_REVIEW_REQUIRED` with reason + timeline event | code; poison path not automated |
| F16 | P1 | SEB | `GET …/seb-config` (student or any `exams:read`) *generated* the config and rewrote the exam policy | GET never generates: `404 SEB_CONFIG_NOT_GENERATED` | hardening, secure-client |
| F17 | P2 | Booklet JSON | staff access by role-name list, no permission, no export lock (scripts readable during LIVE) | permission-based (`marks:approve` / `examcell:candidates:read` / `attempts:read`) + `assertExportAllowed` | hardening |
| F18 | P2 scale | Observations | every heartbeat/save rewrote the observation row (≈510 updates/s at 2k; 7M dead tuples per sitting) | touch at most once per minute per address | load run (8,079 → 300) |
| F19 | P2 | Limits | heartbeat/scan/reconnect had no per-user limit; activation 60/5 min per IP would block a lab behind NAT | 30/10/20 per minute per user; activation 600/5 min per IP | hardening |
| F20 | P2 web | Drafts | one large drawing (>1.5 MB JSON) silently disabled sessionStorage persistence for every question; stale snapshot could overwrite newer server text after reload | per-question entries with an index; only the oversized question loses persistence | drafts-persistence |
| F21 | P2 web | Auth | `/auth/me` network failure on reload bounced a logged-in student to `/login` | keep the stored session, retry in 5 s | auth.tsx |
| F22 | P3 web | Signals | right-click and Ctrl+S/P/U were reported as "High" `VISUAL_ANOMALY` | blocked without a signal; DevTools chords → `DEVTOOLS_ATTEMPT`; `VOIDED_BY_AUTHORITY` has its own honest screen | workspace |

Earlier in the same day (previous commits): migrations on a fresh cluster, `SYSTEM_SCAN` end to end, IP tracking with `ipPolicy`, full whiteboard with one vector renderer, one super admin + four staff logins per tenant, demo seed within the cap, offline-draft recovery notice, 26 black-box probes.

## 3. Open findings (ordered; none on the student's path during the sitting)

| # | Severity | Area | Finding (file) | Recommended fix |
|---|---|---|---|---|
| O1 | P1 integrity | Papers | `GET /exams/:id/paper` and `GET /candidates/:attemptId/paper` return rubric + expected answer to every `exams:read` role (proctor, HOD, report viewer, evaluator) in any status; `paper.viewed` audits only APPROVED; plaintext `paper_questions` is what readers get, the `encrypted_body` blob is write-only (`papers/service.ts:27-84, 337-355, 567-573`) | restrict to `paper:write`/`paper:review`/`marks:approve`; strip key unless reviewer/evaluator and attempt sealed; audit every read; apply the export lock during PRECHECK/LIVE; either decrypt-at-LIVE or drop the "encrypted" claim |
| O2 | P1 integrity | Marking | any tenant-wide `marks:approve` holder marks any attempt; no assignment check; `EXAM_CELL_REVIEW→ACADEMIC_MARKING_READY` written raw (`evaluation/service.ts:213-266`); the evaluator UI posts to `/candidates/:id/result-versions`, bypassing assignments and anonymisation (`EvaluatePage.tsx:338`, booklet JSON shows name/register number) | one marks endpoint requiring an assignment; scope by exam; mask identity in the booklet for anonymised exams; route status through `setPacketStatus` |
| O3 | P1 capacity | Answers | a canvas re-sends the whole block on every save; `answer_revisions.ops` grows quadratically for long answers (one heavy drawer ≈330 MB/hour, 2,000 students ≈ tens of GB per sitting); ~245 ms main-thread CPU for a 2.7 MB save | stroke-level `append-items` op for canvases, text diffs for paragraphs; per-block hash cache; longer debounce for drawing |
| O4 | P1 ops | Load | no load test on target infrastructure; numbers above are one box | Gate G: k6 at 2,000 virtual students on the exam-day tier with PgBouncer, two API nodes, one worker; verify p95 < 300 ms and zero `DB_BUSY` |
| O5 | P1 post-exam | Result totals | `recordResultVersion` sums submitted items only; partial sets and duplicate question ids accepted; `max_marks` not pinned to the paper (`candidates/service.ts:149-153`) | require item set == paper question set (zero-fill allowed), unique ids, `max === paper.total_marks` |
| O6 | P1 post-exam | Booklet cache | a staff render before publication is cached under `attemptId:v{version}` and served to the student after publication with "Publication: Pending" | key by `published_at`/grant id, or never cache non-PUBLISHED renders |
| O7 | P2 security | Readiness | `CLIENT_VERSION` passes on a client-declared build string; SEB Config Key alone is derivable by the student from the downloadable `.seb`; `SYSTEM_SCAN` clean = PASS (source CLIENT_DECLARED) | §11 decision: verify the Browser Exam Key (`X-SafeExamBrowser-RequestHash`) with a server-held key; treat build strings as UNVERIFIABLE (exception-coverable); keep scan as context |
| O8 | P2 security | Auth | lockout DoS: every failed login re-arms the 15 min lock; anyone knowing a student's e-mail can keep it locked during the window (`auth/service.ts:39-51`) | lock only on transition, cap extension, per-account global limiter, activation-link recovery at the desk |
| O9 | P2 security | SSRF | webhook URLs, ERP base URLs, SMTP relay hosts accept private ranges and arbitrary headers | resolve + deny RFC1918/link-local/loopback/IMDS, https-only, per-deployment host allowlist (Phase 9 item, pull forward) |
| O10 | P2 security | Mail settings | `tenant_mail_configs.settings` stores refresh/access tokens and API keys unsealed | seal those keys on write, resolve on use |
| O11 | P2 | Papers SoD | author may approve their own paper (EXAM_CELL_OPERATOR and CONTROLLER hold both permissions) | refuse `approved_by === created_by`; record `submitted_by` |
| O12 | P2 | State machine | remaining raw status writes: ALLOCATED→EXPIRED on close (not in table), bulk ALLOCATED→PRECHECK_AVAILABLE, sweep ACTIVE→RECOVERY_PENDING, `sealAttempt` final write; no tables for incidents/revaluation/precheck runs | add the transitions, call `assertTransition` at each site |
| O13 | P2 | Humans decide | similarity analysis places `INTEGRITY_HOLD` automatically with no audit/decision row; `/proctor/events` accepts server-only classes (`CONCURRENT_SESSION`) from clients | return pairs for the Exam Cell to hold; reject `SERVER_ONLY_SIGNAL_CLASSES` at ingest |
| O14 | P2 | Idempotency | middleware caches error responses forever, concurrent identical requests both execute; no keys on marks/holds/revaluation/moderation; staff roster import without a key | store only <500 responses, in-flight marker on insert, expiry sweep; `Idempotency-Key` on the listed routes |
| O15 | P2 ops | Mail | callback `FAILED` is terminal (throttled flows never retried) while rows without a callback are re-sent after 15 min; 2,000 result mails ≈ 20 min to hand off on one BULK lane; ACS/SES transports use the wrong auth and cannot work against the real services | retry `FAILED` with back-off, don't re-send before a definitive callback, real SigV4/HMAC or drop the transports until needed |
| O16 | P2 ops | PDF | one shared Chromium, no concurrency cap/timeout, local disk only, no image/`playwright install` in the repo | render queue (≤2 concurrent), 30 s timeout, object storage, Dockerfile |
| O17 | P2 web | Sessions | duplicate tab shares the refresh token (both tabs signed out on the next rotation); device-session id lives in sessionStorage so a new tab is a "second device" | BroadcastChannel leader for refresh; device id per attempt in localStorage (not a credential) |
| O18 | P3 | Hot path | `requireUser` opens a transaction per request (≈45 % of a heartbeat's DB work); exam policy read per request; `/proctor/events` N+1; `attemptTimeline` unbounded; forensics loads every revision's `ops` | cache principal 10 s in Redis (family-revoked flag already instant); cache policy by `policy_version`; batch ingest; paginate timeline; select hashes only |
| O19 | P3 | Misc | append-only triggers missing on `submission_manifests`, `resume_grants`, `controller_publication_grants`; a few non-RFC7807 bodies; `/healthz` leaks `e.message`; public verify endpoints unlimited; OIDC `redirectUri` unpinned, http issuer allowed, `email_verified` ignored; `policy_version` not bumped on client-policy changes; `/candidates/queue` de-anonymised; revaluation makes the published result disappear; dead hall-ticket QR route; equation/table blocks not printed | each is a small, local change; tracked in the checklist |
| O20 | docs | Status | plan §7 / README / deployment / capacity docs lag the code (counts, "PDF pending", "mail workers in API process", "strict CSP") | corrected where touched today; remaining lines listed in the post-exam review notes |

## 4. Readiness verdict for 2,000 × 4 h

**Demonstrated on one box:** the request path, the integrity invariants under concurrent requests, the deadline and close behaviour, the client's behaviour under refusals/outages, and that the database fails fast instead of queueing.

**Required before a real sitting (in order):**
1. O1 and O2 (answer key and marking scope) — integrity of the paper and the marks.
2. O4 on the exam-day tier (2 API nodes behind PgBouncer, 1 worker, D4ds-class PostgreSQL, Redis with persistence or accept the 90 s grace window on failover), with the request mix in `docs/deployment.md` and the SQL in `load-smoke.ts` for forks/deadlocks.
3. O3 (delta encoding of drawings) if drawing-heavy papers are expected; otherwise the 4 MB document bound and the 240-saves/min limiter hold the line.
4. Exam-day runbook: two API processes, `DB_POOL_MAX=20`, worker with all seven loops, Chromium present, `STORAGE_DIR` shared, alerts on `DB_BUSY` count, `attempt_event_log` tripwire violations (should be zero), `seal-closed-exams.pending`, mail lane depth.
5. O5–O6 before publication of the first results; O7 is a §11 decision for the university.

## 5. How this was produced

- Reviews: four parallel read-only audits, each required to cite `file:line` and mark CONFIRMED vs SUSPECTED; every CONFIRMED item was re-read before being fixed or listed.
- Load: `npx tsx apps/api/scripts/load-smoke.ts --students N --seconds S` against a running API on a fresh `examos_dev` (requires `PLATFORM_BOOTSTRAP_KEY` in the API's environment); the script prints latency percentiles, DB write volumes and the fork/deadlock counts used above.
- Deadlock diagnosis came from the PostgreSQL log (`deadlock detected … advisory lock [·,2,·] … [·,3,·]`), not from guessing; the lock order is written down in `apps/api/src/lib/locks.ts` and ADR 0007.
