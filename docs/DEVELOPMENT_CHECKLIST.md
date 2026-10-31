# Development checklist

Statuses: **Not Started** · **In Progress** · **Tested** (an automated test exercises it against the real database) · **Completed** (tested *and* reviewed/accepted by the university). Nothing is marked Completed yet because no university acceptance has happened. "Tested" names the test file.

## Platform and tenancy
| Feature | Status | Evidence |
| --- | --- | --- |
| Tenant groups, tenants, domains; host-based tenant resolution | Tested | tenancy.test.ts |
| Row-level security on every tenant table, forced, app role without bypass | Tested | tenancy.test.ts (zero rows without context, cross-tenant insert refused) |
| Append-only audit with per-tenant hash chain; evidence tables append-only at privilege + trigger level | Tested | tenancy.test.ts |
| Tenant provisioning (platform bootstrap key) with admin activation mail | Tested | helpers/provisionTenant |
| Platform admin accounts replacing the bootstrap key: one super admin per deployment (password + sealed TOTP, replay-proof codes, platform-bound sessions, lockout); bootstrap key refused in production | Tested | platform-and-staff.test.ts; `npm run platform:create-admin` |
| Per-tenant rate-limit pools (student saves vs integration) | Tested (limiter) / Not Started (load proof) | auth.test.ts lockout; Gate G load test pending |

## Identity and access
| Feature | Status | Evidence |
| --- | --- | --- |
| Local login, bcrypt, lockout, constant-work failure path | Tested | auth.test.ts |
| RS256 access tokens (10 min), JWKS, no roles in tokens | Tested | auth.test.ts |
| Refresh rotation with reuse detection (family revocation) | Tested | auth.test.ts |
| Permissions re-read from role_grants per request; scoped ABAC (exam/department) | Tested | auth.test.ts, exam-flow (student vs staff routes) |
| Single-use activation links; no passwords in mail | Tested | auth.test.ts |
| Login/refresh/activation sessions record ip and user agent (context, never a verdict) | Tested | network-and-scans.test.ts |
| Refresh rotation honours one retry inside a 30 s window after a lost response (one child revoked, family revoked on any further reuse); the client ends the session only on 401/403 from the refresh endpoint | Tested | scale-invariants.test.ts, auth.test.ts, apps/web/test/api-refresh.test.ts |
| 3–4 named staff logins per tenant (service check + database trigger + platform-set limit), duty bundles grant every staff role, students unlimited and never staff roles, no self role/status change | Tested | platform-and-staff.test.ts |
| OIDC (Microsoft Entra / Google Workspace): discovery, PKCE, nonce, JWKS verification, no JIT provisioning, domain allowlist | Tested | auth.test.ts (fake IdP) |
| MFA for high-impact roles | Not Started | — |

## ERP integration (Simple API)
| Feature | Status | Evidence |
| --- | --- | --- |
| Tenant API keys (SHA-256, scopes, revoke, expiry, IP allowlist) | Tested | integration.test.ts |
| Roster push: academic units (school→dept→programme), courses, persons, enrolments; per-row outcomes; sync jobs | Tested | integration.test.ts |
| Identity by (provider, externalId); e-mail never merges; IDENTITY_CONFLICT | Tested | integration.test.ts |
| Idempotency-Key replay / 409 on body change | Tested | integration.test.ts |
| Integration events + outbox; signed webhooks; backoff; dead-letter; admin replay | Tested | integration.test.ts |
| Cursor event feed | Tested | integration.test.ts |
| Results pull (published only, no proctoring data) | Tested | exam-flow.e2e.test.ts |
| XLSX import (L0) through the same roster service (download templates, preview, identity conflicts, per-row outcomes) | Tested | erp-adapters.test.ts, erp-import.test.tsx |
| Adapters that pull from the ERP (`uos`, `generic-rest` with field mapping, dry-run & live sync) | Tested | erp-adapters.test.ts, erp-import.test.tsx |

## Exam mail
| Feature | Status | Evidence |
| --- | --- | --- |
| Outbox with dedupe, two lanes, SKIP LOCKED claiming, backoff, callback timeout | Tested | mail.test.ts |
| Power Automate transport + callback endpoint (bearer secret) | Tested | mail.test.ts (emulated flow) |
| Graph transport (app permission, scoped mailbox) | In Progress | code present, not exercised against Graph |
| SMTP relay transport (Nodemailer) against a live SMTP responder: delivery, 451 retry with back-off, 550 permanent failure | Tested | apps/api/test/mail-smtp.test.ts |
| SMTP OAuth2 transport | In Progress | code present, not exercised against a server |
| Versioned templates, HTML escaping, per-tenant override | Tested | mail.test.ts |
| Bounce reconciliation from the shared mailbox and NDR webhooks | Tested | erp-adapters.test.ts, erp-import.test.tsx |

## Exam lifecycle and conduct
| Feature | Status | Evidence |
| --- | --- | --- |
| Exam create with type/year/semester/profile (aliases normalised), hierarchy filters | Tested | exam-flow.e2e.test.ts |
| Human-triggered conduct: submit-for-review → approve → schedule → open readiness → start → close; illegal transitions refused | Tested | exam-flow |
| Allocation of eligible students only; locked while PRECHECK/LIVE | Tested | exam-flow |
| Hall tickets per exam, PDF with signed verification QR, visible per exam to the student | Tested | exam-flow, documents.test.ts |
| Export lock during PRECHECK/LIVE with audit + alert mail | Tested | exam-flow |
| Question paper authoring, sections, kinds, rubrics, draft/review/approved lifecycle | Tested | paper.test.ts, paper-tab.test.tsx |
| Question paper encryption at rest (AES-256-GCM), canonical SHA-256 seal, exam approval gate (marks match) | Tested | paper.test.ts |
| Question paper sets generation (Set A/B question shuffling) | Tested | paper.test.ts |
| Student paper release (gate exam LIVE, expected_answer & rubric stripped, paper_releases append-only audit) | Tested | paper.test.ts |
| Candidate paper view & answer booklet question prompts & evaluator marking validation | Tested | paper.test.ts, booklet.test.tsx |
| Question paper ingestion (DOCX/PDF), question bank | Not Started | spec §5, §12 |
| Rooms, benches, seat assignments | Not Started | spec §40, §50 |

## Readiness check and admission
| Feature | Status | Evidence |
| --- | --- | --- |
| Precheck runs/items with sources; server-measured identity/eligibility/consent | Tested | exam-flow, recovery |
| Clock sync, keyboard functional test (no WPM), optional canvas/stylus test, practice save round-trip | Tested | exam-flow |
| System scan (SYSTEM_SCAN): server-derived findings from the raw client scan (displays, automation, VM/remote-desktop hints, screen sharing, full-screen/cookies, window/viewport, time zone compared by UTC offset so aliases such as Asia/Calcutta = Asia/Kolkata never flag, battery); blocking findings remediate; clean scans stay CLIENT_DECLARED | Tested | exam-flow (dual display → REMEDIATE, clean → PASS), network-and-scans.test.ts, device-scan.test.ts |
| Secure client verification via SEB Config Key hash (header path and JavaScript-API path, page URL bound to the exam host), optional Browser Exam Key allow-list; allowed client builds | Tested | recovery.test.ts, secure-client.test.ts |
| SEB required at entry grant, admission and reconnect (record `SECURE_CLIENT_MISSING`, then refuse; grant not burned); live heartbeats without the key flagged, saves never refused | Tested | recovery.test.ts |
| SEB configuration generator: one settings object → `.seb` plist + Config Key per the SEB algorithm (recomputed independently in the test), URL filter to the exam host, force-quit (`strongKill`) list for Windows and macOS plus Exam Section additions, one display/no mirroring/no capture/no VM, kiosk keys, hashed quit password; frozen once LIVE; SECURE_BYOD only; download authorization and audit | Tested (acceptance with real SEB builds pending — rehearsal step in docs/seb-rollout.md) | secure-client.test.ts |
| MANAGED_ENDPOINT lab network subnet attestation and client policy management | Tested | secure-client.test.ts |
| Extended client-side signals (DISALLOWED_APP_DETECTED, VIRTUAL_MACHINE_DETECTED) with human-only warning invariant | Tested | secure-client.test.ts |
| Pre-publication staff booklet download audit (booklet.downloaded) | Tested | secure-client.test.ts |
| Camera/microphone honest UNVERIFIABLE on high tiers | Tested | exam-flow |
| Readiness board for the Examination Section (per check, instruction, blocking, exceptions) | Tested | exam-flow |
| Admission exceptions; security checks waivable only by Controller; expiry | Tested | exam-flow, recovery |
| One-time admission grant consumed atomically; lobby until exam LIVE | Tested | exam-flow (6-way race) |
| Face reference / 1:1 match / PAD / manual referee | Not Started | Gate C |
| Media snapshot verification for camera/mic | Not Started | Gate C |

## Answers and submission
| Feature | Status | Evidence |
| --- | --- | --- |
| Versioned saves, client operation idempotency, revision conflict, content hash verification | Tested | exam-flow |
| Device-session binding; second device = server-observed incident | Tested | exam-flow, recovery |
| Heartbeat, IP-change logging, stale sweep → RECOVERY_PENDING, reconnect | Tested | recovery.test.ts |
| Atomic seal: manifest, receipt, candidate packet, idempotent submit, late writes refused | Tested | exam-flow |
| Server deadline authority at close (expire + seal) | Tested | exam-flow |
| Canvas vector blocks stored and server-side PDF render pipeline | Tested | documents.test.ts, web renders |
| Server-side validation of every stored answer block by kind (paragraph ≤ 50k chars, drawing per CanvasContentSchema, choice), document ≤ 200 blocks / 4 MB; refusals are 422 the client does not blindly retry | Tested | hardening.test.ts, apps/web/test/sync-backoff.test.ts |
| Per-attempt deadline authority: writes refused from the deadline, the attempt sealed by the worker ≈30 s later, receipt returned through the heartbeat; exam close sets all deadlines in one statement and seals one attempt per transaction (inline budget + worker) | Tested | hardening.test.ts, scale-invariants.test.ts, exam-flow |
| Whiteboard: pen, highlighter, eraser, line, arrow, rectangle, ellipse, text; colours, widths, fill, text sizes, paper (grid/ruled/dots), undo/redo, clear, grow; one scene builder (`@examos/contracts` canvas-render) for workspace, booklet, evaluator and server PDF; erasers only remove earlier items; contract limits enforced client- and server-side; the Text tool keeps focus under a real mouse (the canvas cancels mousedown) | Tested | apps/web/test/drawing.test.tsx, booklet.test.tsx; documents.test.ts (PDF) |
| Offline draft recovery UI: drafts kept in sessionStorage are restored on open, the student is told which questions and that they are being sent, with Retry now / Retry saving now actions | Tested | apps/web/test/exam-workspace.test.tsx (restore after reload) |

## Proctoring
| Feature | Status | Evidence |
| --- | --- | --- |
| Signal ingest with dedupe and grouping window; technical classes uncountable | Tested | exam-flow |
| Server-only classes (CONCURRENT_SESSION, NETWORK_ADDRESS_CHANGED, SECURE_CLIENT_MISSING) refused from clients; signal metadata bounded to 2 KB; timeline returns every raw signal with context and server receipt time | Tested | network-and-scans.test.ts |
| Browser lockdown in the workspace: full-screen gate (refusal never traps), paper hidden while away, Keyboard Lock, leaving the exam (tab hidden vs another app) with time away, display change (second screen, projector/mirroring, resolution, scaling) with before/after + immediate device scan, duplicate tab, split-screen, print/PrintScreen/DevTools, external paste | Tested | apps/web/test/lockdown.test.tsx; network-and-scans.test.ts; browser rehearsal (apps/web/e2e) |
| Proctor console says what was reported in words (time away, display before/after, faces, SEB route) for the incident and on the timeline | Tested | apps/web/test/proctor.test.tsx |
| On-device camera presence (opt-in per exam): no face ≥ 8 s / covered camera, second face ≥ 3 s, camera unavailable (technical); hysteresis against single-frame false detections; no image leaves the device; third-party telemetry of the detector refused; CAMERA consent + new policy version; frozen once LIVE | Tested (on real devices: pending the data-protection assessment, plan §11) | apps/web/test/presence.test.tsx, same-origin-guard.test.ts; secure-client.test.ts |
| Human decisions; one warning per incident per epoch; idempotent decisions | Tested | exam-flow |
| Fifth-warning atomic suspension under concurrent saves; alert mail | Tested | exam-flow (race) |
| Resume with new epoch, history retained, deadline extension, device re-bind | Tested | exam-flow, recovery |
| Technical hold (no epoch change) | Tested | recovery.test.ts |
| Hash chains (attempt timeline, tenant audit) append under per-chain advisory locks with unique tripwire indexes; incident grouping serialised per attempt; one lock order for signals, saves and decisions (no deadlocks under a 20-request burst on one attempt) | Tested | scale-invariants.test.ts (burst + 20 concurrent logins) |
| Heartbeat sweep: one MGET per tenant, a missing key opens a fresh grace window (Redis flush never bounces writing students); admission/reconnect seed the window | Tested | scale-invariants.test.ts |
| Every hold placed before marks releases into the marking queue; the forensics lane routes a failing packet to technical review instead of stalling | Tested | hardening.test.ts (release; poison packet → TECHNICAL_REVIEW_REQUIRED, next packet still processed) |
| IP tracking: attempt_network_observations on every readiness/admission/in-exam request, admitted_ip binding, ipPolicy LOG/REVIEW/LOCK (record-then-refuse under LOCK; proctor resume + rebind releases), lab-subnet refusal for managed endpoints; addresses in the proctor timeline and the evidence PDF | Tested | network-and-scans.test.ts |
| In-exam device scans every 60 s (append-only device_scans); blocking findings → mapped review signals grouped per incident, never a warning or a pause; student told what to fix; scans in the proctor timeline and the evidence PDF | Tested | network-and-scans.test.ts |
| Rolling media buffer, 5-second clips, 5 snapshots, gap detection, evidence viewer | Not Started | Gate C/D |
| AI vision/audio signal producers | Not Started | Gate C/D |

## Post-exam
| Feature | Status | Evidence |
| --- | --- | --- |
| Forensic completeness checks (manifest, ledger, timeline chain, incidents) | Tested | exam-flow |
| Examiner marks with one explanation per question; range/criteria validation | Tested | exam-flow |
| Exam Cell checklist + approval bound to result version; invalidation on new version | Tested | exam-flow |
| Holds and release with student notice and ERP event | Tested | exam-flow |
| Controller authorization + publication; idempotent | Tested | exam-flow |
| Lifelong student ledger; semester and overall rollups | Tested | exam-flow |
| Digital answer booklet JSON + verification endpoint | Tested | exam-flow |
| Booklet PDF rendering (server-side), hall tickets, and restricted evidence PDF with verification QR codes | Tested | documents.test.ts |
| Student document storage (photo, ID card), explicit consent gate, SHA-256 hash, and audit trail | Tested | analytics.test.ts |
| Verifiable student examination ID card with signed QR and safe public verification endpoint | Tested | analytics.test.ts |
| Department academic analytics (pass rate, semester rollups, exam distribution, HOD department scoping, strict proctoring privacy) | Tested | analytics.test.ts |
| Evaluator workload balancing and batch assignment | Tested | evaluation-scale.test.ts, evaluation.test.tsx |
| Anonymized candidate marking for external exams (masks student identity) | Tested | evaluation-scale.test.ts, evaluation.test.tsx |
| Double evaluation with divergence threshold (15%) and moderator resolution | Tested | evaluation-scale.test.ts, evaluation.test.tsx |
| Revaluation lifecycle (student request, window check, exam cell decision, re-marking, ledger supersede, and result.corrected event) | Tested | evaluation-scale.test.ts, evaluation.test.tsx |
| Automatic mark proposals (replaces the word-count "AI" draft): MCQ answer key read from explicit choices only, NUMERIC expected values with tolerance, rubric key terms per criterion with found/missing evidence, no answer → 0, drawings and unkeyed questions left to the examiner; length never earns marks. Proposals load with the script and pre-fill unmarked questions; a mark that differs needs the examiner's reason (server-enforced, recomputed server-side) and proposal, method and reason are kept in the result version | Tested | auto-marks.test.ts, exam-flow.e2e.test.ts, evaluation-scale.test.ts; apps/web/test/evaluate-marks.test.tsx |
| Rubric steps with difficulty 1–10 (full credit at 100 % of key terms for 1, 80 % for 5, 55 % for 10; nearest half mark, ties up); paper editor for steps, difficulty, key terms and answer keys; "read carefully" on partial credit | Tested | auto-marks.test.ts; apps/web/test/rubric-editor.test.tsx, evaluate-marks.test.tsx |
| System evaluates each script when it reaches marking (`mark_proposals`), shown in the examiner's queue; Exam Section can re-run it for an exam | Tested | exam-flow.e2e.test.ts |
| One release of all results by the COE (`POST /exams/:id/publish-results`): CLOSED exam, every script approved, holds withheld, idempotent; no single publication before it; published results cannot be re-marked | Tested | exam-flow.e2e.test.ts; apps/web/test/candidates-drawer.test.tsx |
| Revaluation decided only by the COE; every change from the published mark needs a reason; ledger supersedes | Tested | evaluation-scale.test.ts |
| Question kinds MCQ_MULTI (partial credit, never below zero), MATH (expression equivalence), NUMERIC with units and answer/method marks, must-not-miss rubric steps; option buttons, final-answer box and code editor in the workspace; answer-key editors in the paper editor | Tested | auto-marks.test.ts, code-exam.test.ts; apps/web/test/structured-answer.test.tsx, rubric-editor.test.tsx; browser check of the demo exam CS301-LAB |
| CODE questions: sample runs during the exam (visible samples only, limited per question, device-bound), hidden-test grading after sealing by a worker with lease/retries, proposals from test weight; Judge0 adapter | Tested against an in-process judge and a fake Judge0 HTTP server; a real Judge0 deployment is pending | code-exam.test.ts |
| Booklet tells the student how the marks were decided and how to apply for revaluation | Tested | browser rehearsal (apps/web/e2e) |
| Answer similarity analysis and adjudication (MinHash/shingles, integrity hold) | Tested | evaluation-scale.test.ts |

## Web application (apps/web) — React 19, Vite, Tailwind 4, TanStack Query, React Router 7, custom components
| Feature | Status | Evidence |
| --- | --- | --- |
| Login (password + SSO redirect), activation, OIDC callback, public verify page | Tested | apps/web/test/login.test.tsx; smoke-tested against the live API |
| Student: exam list with one status-driven action, hall ticket drawer (printable), lobby polling, ledger | Tested | smoke-tested; readiness/time reducers unit-tested |
| Student Profile & ID: identity card, photo upload with consent modal, verification QR code, SVG performance progression chart | Tested | apps/web/test/profile.test.tsx |
| Academic Analytics: department dashboard for HOD/Controller, KPI metrics, semester rollups, course distributions, strict privacy assurance | Tested | apps/web/test/analytics.test.tsx |
| 15-minute readiness screen (one step at a time, no WPM, optional drawing, automatic system scan with rescan, consent, camera preview, verdict stamp) | Tested | apps/web/test/readiness-screen.test.tsx, readiness.test.ts; smoke-tested end to end |
| Exam workspace resilience: saves resume on every ACTIVE heartbeat, 15 s request timeouts, exponential back-off with jitter, no blind retry of refused content, capped rebases, last-call flush 10 s before the deadline, editor unlocks on a deadline extension, Submit stays available after time is over, receipt via heartbeat, heartbeats single-flight / on wake-up / stopped once sealed, per-question draft persistence | Tested | apps/web/test/sync-backoff.test.ts, api-refresh.test.ts, drafts-persistence.test.ts, exam-workspace.test.tsx |
| Exam workspace: server-derived timer, question map, paragraph + whiteboard editor, autosave with baseRevision/clientOperationId/contentSha256, 409 rebase, draft queue, heartbeat, periodic system scan with plain-language notice, paused overlay, device-mismatch screen, signal reporting, submit with receipt | Tested | apps/web/test/exam-workspace.test.tsx, sync.test.ts, answers.test.ts, canonical.test.ts; smoke-tested (typed + drew → 200, hash matched server) |
| Digital answer booklet with print layout (A4, page per question) | Tested | apps/web/test/booklet.test.tsx; printed to PDF in smoke test |
| Exam Section: hierarchical exam list, new exam, conduct controls with consequence dialogs, allocations, hall tickets, Readiness Board (10 s), exceptions, Candidates with checklist drawer (approve/hold/release/authorize), export lock message | Tested | apps/web/test/readiness-board.test.tsx; smoke-tested through the full post-exam chain |
| Safe Exam Browser integration: student .seb download through the authenticated client (the plain link never carried a token), SEB JavaScript-API headers, Exam Section panel (quit password, extra apps to force-close, Browser Exam Keys), camera presence switch | Tested | apps/web/test/secure-client.test.tsx, seb-js-api.test.ts |
| Evaluator marks screen (assigned queue, anonymization, one explanation per question, criteria; lists exactly the approved paper's questions) | Tested | apps/web/test/evaluation.test.tsx; smoke-tested; evaluate-marks.test.tsx |
| Proctor console (5 s queue, decisions, technical hold, resume for Chief Proctor, timeline with network addresses and device scans) | Tested | apps/web/test/proctor.test.tsx (queue, drawer, timeline sections); decisions smoke-tested |
| Tenant admin (users/roles, mail config, mail log, SSO, API keys, webhooks, deliveries replay, audit); opens on the first tab the role may see | Tested | apps/web/test/admin.test.tsx |
| Question paper rendering in the workspace (released paper, question navigator, prompt per question) | Tested | apps/web/test/exam-workspace.test.tsx (mocked released paper) |

## Operations
| Feature | Status | Evidence |
| --- | --- | --- |
| Worker loops (outbox, webhooks, two mail lanes, forensics, heartbeat sweep, deadline sweep, seal-closed-exams) | In Progress | functions tested per pass (scale-invariants, hardening); long-running loop not load-tested |
| Database guard-rails: DB_POOL_MAX honoured, pool acquire timeout, role lock/statement/idle-in-transaction timeouts, busy database → 503 DB_BUSY retryable | Tested (mapping) / In Progress (saturation not reproduced in CI) | migration 0102, errors.ts; load-smoke |
| Single-box load smoke (`apps/api/scripts/load-smoke.ts`): 300 students × 90 s of the real request mix, latency percentiles, write volume, chain-fork count | Tested (run on 2026-10-30, see docs/reviews) | not a substitute for Gate G |
| 3,000-session load test, 1,500 preflight burst | Not Started | Gate G |
| Capacity & budget model (`scripts/capacity-model.mjs`, `docs/capacity-and-budget.md`) | Tested (model runs; figures are estimates, not measurements) | 1,000 × 3.5 h → ~125 req/s, ~0.6 GB/sitting, ≈ $16 burst per exam day |
| Exam-day scale runbook script (`infrastructure/azure/scale-exam-day.sh`) | Not Started (template only, never run against a subscription) | docs/capacity-and-budget.md §5 |
| BULK-lane transport for external recipients (ACS Email / SES) with quota tracking | Tested | erp-adapters.test.ts, erp-import.test.tsx |
| Revision archival job (hot → Blob Archive after appeal window) | Not Started | docs/capacity-and-budget.md §1 |
| Backups, PITR drills, observability dashboards | Not Started | Gate G |
| Dependency audit (`npm audit`, prod + dev) | Tested | 0 vulnerabilities after upgrades (docs/security-review.md) |
| Black-box security probes (26 checks: auth, IDOR, injection, mass assignment, headers, tokens, rate limit, device scans, network policy, platform surface) | Tested | `npm run security:probes` |
| Route coverage: every registered route documented in the route map and vice versa; anonymous and forged-token calls refused on every non-public route; garbage bodies, params and queries never produce a 5xx; NUL characters refused at the edge | Tested | apps/api/test/route-coverage.test.ts |
| Deploy smoke test (`npm run smoke`): health, tenant, JWKS, sign-in and home screen per role, refusals, problem objects, security headers, server-only signal refusal, refresh rotation/retry/revocation, latency | Tested (16/16 on the demo stack, 2026-10-31) | apps/api/scripts/smoke.mjs |
| Exam-day browser rehearsal (every role through the real UI, with lockdown signals and camera presence; optional captioned video) | Tested (15/15 steps, 2026-10-31) | apps/web/e2e/exam-day-rehearsal.cjs |
| Independent penetration test, DAST/SAST in CI, privacy impact assessment | Not Started | docs/security-review.md lists the required scope |
