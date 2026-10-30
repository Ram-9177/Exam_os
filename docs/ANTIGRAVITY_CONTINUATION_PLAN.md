# SMRU ExamOS — Continuation plan and handover

**Purpose.** This is the complete, top-to-bottom handover of SMRU ExamOS for continuing the build in Google Antigravity (or any agentic IDE): what the product is, every role and feature, the data and API model, every end-to-end flow, the honest status of each feature, the remaining work in dependency order with acceptance criteria, and the rules an agent must follow so the platform stays trustworthy. It is written so that an agent with no prior context can open the repository and continue without re-deriving anything.

**Read in this order.** §0 (how to work) → §1 (product and roles) → §3 (canonical model) → §6 (flows) → §7 (status) → §8 (the plan) → §9 (rules). `AGENTS.md` at the repository root is the short form that Antigravity loads automatically; `.agents/workflows/` holds the slash-command workflows; this file is the long form.

**Status vocabulary (never change it).** *Not Started* · *In Progress* · *Tested* (an automated test exercises it against the real PostgreSQL 16 and Redis 7) · *Completed* (Tested **and** accepted by the university). Nothing is Completed yet. A feature without a test is never more than In Progress.

As of 30 October 2026. Source of truth for status: `docs/DEVELOPMENT_CHECKLIST.md`.

---

## 0. How to work on this codebase

### 0.1 First hour in Antigravity

1. Open the repository root (`smru-examos/`). Antigravity reads `AGENTS.md` and `.agents/rules/*.md` automatically; the workflows in `.agents/workflows/` appear as `/implement-feature`, `/verify`, `/exam-day-rehearsal`.
2. Start PostgreSQL 16 and Redis 7 (`infrastructure/docker/docker-compose.yml`), copy `.env.example` → `.env`, run `npm install` (`.npmrc` sets `legacy-peer-deps=true`).
3. Run `npm run migrate && npm run seed`, then `npm test` (API, 78 tests) and `npm test -w @examos/web` (71 tests). Both must be green before any change. `npm run security:probes` (26 black-box probes) needs a running demo server (`npm run demo` seeds a tenant with the credentials in §2.8).
4. Pick the next item from §8 in order. Do not skip phases: later phases depend on earlier tables and contracts.
5. For every feature: contracts → migration → service → routes → tests → web → docs/checklist, in that order (§0.2). Update `docs/DEVELOPMENT_CHECKLIST.md` in the same change.

### 0.2 The change recipe (one feature = one branch = one checklist row)

| Step | Where | Rule |
| --- | --- | --- |
| 1. Vocabulary | `packages/contracts/src/enums.ts`, `state-machines.ts` | Add enums/transitions first; the DB check constraints, Zod and UI all import them. Never a second vocabulary for the same thing. |
| 2. Contracts | `packages/contracts/src/api.ts` / `integration.ts` | Zod schemas for every request and response. The route must `parse` the body; unknown keys are stripped. |
| 3. Migration | `packages/db/migrations/2026…_<name>.ts` | Every business table has `tenant_id` and is listed in `TENANT_TABLES` (RLS is applied from that list by `…_0099_rls_and_app_role.ts` — add new tables **before** 0099 by re-running its grants, or add a new migration that enables/forces RLS and grants the app role). Evidence tables go in `APPEND_ONLY_TABLES`. |
| 4. Service | `apps/api/src/modules/<module>/service.ts` | Pure functions taking `(deps, trx, tenantId, …)`; every DB access through `withTenantTx`; `assertTransition` before any status change; locks with `forNoKeyUpdate()`; "record then refuse" bookkeeping in its own transaction. |
| 5. Routes | `apps/api/src/modules/<module>/routes.ts` | `requireUser` + `requirePermission('…')`; idempotency middleware on mutating staff actions; errors thrown as `AppError(code, status)`. Add the route to `docs/api/route-map.md`. |
| 6. Tests | `apps/api/test/*.test.ts` | Vitest + Supertest against the real DB (`examos_test` is recreated by `global-setup.ts`). Cover the happy path, the refused path and at least one race where the invariant is concurrency-sensitive. |
| 7. Web | `apps/web/src/features/<area>` | React 19 + TanStack Query; custom accessible components in `apps/web/src/ui` only (no Radix/shadcn); one status-driven action per object; render tests in `apps/web/test`. |
| 8. Docs | `docs/DEVELOPMENT_CHECKLIST.md`, ADR if a decision changed | Status = Tested only when the test exists and passes. |

### 0.3 The ten non-negotiables

1. **Never fake security.** A check the server cannot measure is reported `UNVERIFIABLE`, never `PASS` (ADR 0005). No client-reported value is ever authoritative.
2. **Tenant isolation is the database's job.** Every query runs inside `withTenantTx(db, tenantId, …)`; the worker uses `withWorkerTx`. Never query a tenant table outside those (RLS returns zero rows, which hides bugs instead of failing loudly — tests assert on counts).
3. **State changes go through the transition tables.** `assertTransition('attempt', ATTEMPT_TRANSITIONS, from, to)`; an illegal transition is a 409 `ILLEGAL_TRANSITION`.
4. **Evidence is append-only.** `audit_events`, `answer_revisions`, `proctor_warnings`, `attempt_event_log`, `submission_manifests`, `resume_grants`, `controller_publication_grants` are INSERT-only for the app role and protected by triggers.
5. **Humans decide.** No signal becomes a countable warning without a named human's decision, except the server-observed `CONCURRENT_SESSION`; technical classes are never countable. Suspension happens only on the Nth confirmed warning inside one transaction.
6. **Exams are conducted by people.** Precheck opens, the exam starts and closes only when the Examination Section presses the button; the server enforces the deadline.
7. **Record, then refuse.** When refusing a request must leave evidence (second device, export during exam, failed login, refresh-token reuse), write the evidence in its own committed transaction before throwing.
8. **Idempotency everywhere it hurts.** Saves (`clientOperationId`), submits, decisions, approvals, publication, roster batches (`Idempotency-Key`), mails (`dedupe_key`), webhooks (event id).
9. **Secrets are sealed.** Tenant secrets are `enc:` references (AES-256-GCM with `APP_ENCRYPTION_KEY`) or `env:` references; nothing secret is ever returned by an API.
10. **Status honesty.** Nothing is marked Tested without a test; nothing Completed without university acceptance. The checklist is part of the deliverable.

### 0.4 Kickoff prompt for Antigravity

> You are continuing SMRU ExamOS. Read `AGENTS.md`, then `docs/ANTIGRAVITY_CONTINUATION_PLAN.md` fully, then `docs/DEVELOPMENT_CHECKLIST.md`. Set up the environment per §0.1 and confirm `npm test` and `npm test -w @examos/web` are green. Then start §8 Phase 1 (Question paper module) exactly as specified: contracts → migration → service → routes → tests → web → docs. Work one phase item at a time, keep the test suite green after every step, and update the checklist with evidence. Never mark anything Completed. If a decision in §11 blocks you, stop and ask; otherwise do not ask.

---

## 1. Product definition

### 1.1 What ExamOS is

SMRU ExamOS is a multi-tenant, AI-assisted examination platform for St. Mary's University (and any campus of the group as its own tenant), integrated with the university ERP (UOS) through a simple, ERP-agnostic API. It runs the whole life of an examination digitally while keeping every high-stakes decision human:

- **Exam types:** `MID_1`, `MID_2`, `SEM_INTERNAL`, `SEM_EXTERNAL`, `SUPPLEMENTARY`, `PRACTICAL`, `VIVA`, `ASSIGNMENT`, `OTHER`.
- **Conduct:** the Examination Section creates, schedules and allocates; opens a readiness (pre-check) window; sees who is not ready and why; grants scoped exceptions; starts the exam; the server runs the clock; the Section closes it.
- **Writing:** students write in a browser or in the secure exam client (Safe Exam Browser / managed lab endpoint) with versioned autosave, device binding and interruption recovery; proctors see grouped incidents and decide; five confirmed warnings suspend; a Chief Proctor resumes with a new warning epoch.
- **After the exam:** seal → forensic checks → evaluator marks with **one explanation per question** → Exam Cell approval bound to the result version → Controller authorizes and publishes → lifelong ledger (exam-wise, semester-wise cumulative, overall) → digital answer booklet that reads like a real booklet (question → answer → marks → explanation) with university validation and a public verification link.
- **Mail:** every exam mail leaves from the campus's own shared mailbox (e.g. `exam@smru.edu.in`) through a Power Automate flow (or Graph/SMTP), with an outbox, two lanes and delivery callbacks.
- **Data:** stored lifelong; revisions and evidence append-only; everything scoped by tenant with PostgreSQL row-level security.

### 1.2 Tenancy

One deployment, many campuses: `tenant_groups` → `tenants` → `tenant_domains`. A user belongs to exactly one tenant; tenant is resolved from the request Host header for people and from the API key for integrations. Each tenant has its own SSO config (Microsoft Entra or Google Workspace), mail config (its own mailbox), ERP connection, API keys, webhooks, templates and academic hierarchy (schools → departments → programmes → courses). Cross-tenant mail is simply each tenant's own mailbox sending its own mail; nothing crosses tenants at the data layer (ADR 0001).

### 1.3 Roles and permissions

Permissions are re-read from `role_grants` on every request and never carried in tokens. Grants are scoped (`TENANT`, `TENANT_GROUP`, `DEPARTMENT`, `PROGRAMME`, `COURSE`, `EXAM`).

| Role | Who | Permissions (from `ROLE_PERMISSIONS`) | Screens |
| --- | --- | --- | --- |
| STUDENT | Exam writer | `attempts:own` | `/student`, `/student/ledger`, readiness, exam workspace, booklet |
| QUESTION_SETTER | Faculty authoring papers | `exams:read` (+ paper authoring in Phase 1) | Phase 1: paper editor |
| PAPER_REVIEWER | Faculty/HOD reviewing papers | `exams:read` (+ paper approval in Phase 1) | Phase 1: paper review |
| EVALUATOR | Examiner marking scripts | `exams:read`, `marks:approve` | `/evaluate`, `/evaluate/:attemptId` |
| MODERATOR | Moderation of marks | `exams:read`, `marks:approve` | Phase 6: moderation queue |
| PROCTOR | Invigilator on the console | `exams:read`, `attempts:read`, `proctor:incidents:read`, `proctor:incidents:decide`, `proctor:attempts:hold` | `/proctor` |
| CHIEF_PROCTOR | Senior invigilator | PROCTOR + `exams:conduct`, `proctor:attempts:resume` | `/proctor` (resume) |
| HOD | Head of department | `exams:read`, `roster:read`, `users:read` | read-only lists (Phase 3 analytics) |
| EXAM_CELL_OPERATOR | Examination Section | `exams:read/write/allocate/conduct`, `preflight:override`, `halltickets:issue`, `exports:read`, `roster:read`, `users:read`, `attempts:read`, `examcell:candidates:read/approve` | `/examcell`, exam detail (conduct, allocations, hall tickets, readiness board, candidates) |
| CONTROLLER | Controller of Examinations | EXAM_CELL conduct set + `preflight:override-security`, `controller:publish`, `audit:read` | `/examcell` (publish, security waivers) |
| SYSTEM_ADMIN | University IT | `tenant:manage`, `users:*`, `roster:*`, `integration:manage`, `mail:manage`, `audit:read` | `/admin` |
| TENANT_ADMIN | Campus admin | `tenant:manage`, `users:*`, `integration:manage`, `mail:manage`, `exams:read` | `/admin` |
| INTEGRATION_ADMIN | ERP owner | `integration:manage`, `roster:read/write` | `/admin` (API keys, webhooks) |
| SECURITY_AUDITOR | Audit/security | `audit:read`, `attempts:read`, `proctor:incidents:read` | `/admin` audit (read-only) |
| REPORT_VIEWER | Management | `exams:read` | Phase 3/6 dashboards |

Integration API keys use their own scopes: `roster:write`, `roster:read`, `results:read`, `events:read`, `webhooks:manage`, `mail:callback`.

### 1.4 Security profiles (how strict an exam is)

| Profile | Meaning | Mandatory readiness checks |
| --- | --- | --- |
| PRACTICE | Rehearsal, nothing counts | IDENTITY_SESSION |
| BASIC_BROWSER | Any modern browser, invigilated room | + ELIGIBILITY, NETWORK_SAVE_ROUNDTRIP, CLOCK_SYNC, KEYBOARD_INPUT |
| SECURE_BYOD | Student's own device in Safe Exam Browser; Config Key verified server-side | + CLIENT_VERSION, CONSENT |
| MANAGED_ENDPOINT | University lab machine with managed client | same as SECURE_BYOD (attestation in Phase 4) |

Aliases accepted on input and normalised: `BASIC`, `SECURE`, `BYOD_STRICT`, `SECURE_BYOD_WITH_ROOM_INVIGILATOR`, `MANAGED_LAB`, `MANAGED_MAX`. `CANVAS_INPUT` (stylus/drawing) is always optional. `CAMERA`/`MICROPHONE` are client-declared and shown `UNVERIFIABLE` on high tiers until the media pipeline (Phase 5) exists.

---

## 2. System architecture

### 2.1 Stack (mandated, do not substitute)

Backend: Node 22 + TypeScript, Express 4, PostgreSQL 16 + Knex, Redis 7 (ioredis), Zod 4, JWT RS256 (jose) + bcrypt, Microsoft/Google OIDC, Nodemailer, Vitest + Supertest. Frontend: React 19, Vite 7, Tailwind 4, TanStack Query, React Router 7, custom accessible components (no Radix/shadcn), Vitest + Testing Library. Playwright for UI smoke tests.

### 2.2 Repository map

```
smru-examos/
  AGENTS.md                         # agent rules (loaded by Antigravity)
  .agents/rules/, .agents/workflows/ # modular rules and slash-command workflows
  packages/contracts/src/           # enums.ts, state-machines.ts, api.ts, integration.ts  ← single vocabulary
  packages/db/                      # migrations/ (12 + RLS), src/index.ts (withTenantTx, TENANT_TABLES), src/seed.ts
  apps/api/src/
    app.ts, config.ts, server.ts, worker.ts
    middleware/   auth, api-key, idempotency, rate-limit, request-context, error-handler
    lib/          audit, crypto, errors, http, identity (erpIdentity), secrets
    modules/      auth, tenants, users, integration (roster, events, webhooks, api-keys),
                  notifications (service, worker, transports/*), exams, attempts, proctoring, candidates
  apps/api/test/                    # tenancy, auth, integration, mail, exam-flow.e2e, recovery (+ helpers, global-setup)
  apps/api/scripts/                 # demo-seed.ts, security-probes.mjs
  apps/web/src/                     # app/router.tsx, features/{auth,student,readiness,exam,drawing,booklet,examcell,evaluate,proctor,admin}, lib/, ui/
  apps/web/test/
  docs/                             # this plan, checklist, ADRs, route map, case matrix, deployment, security review, capacity & budget, Power Automate guide
  infrastructure/docker/, infrastructure/azure/
  scripts/                          # package.sh, capacity-model.mjs
```

### 2.3 Request pipeline

1. Reverse proxy terminates TLS and forwards **Host** unchanged; `trust proxy` is on in production.
2. `request-context` assigns `x-request-id`; `helmet`; JSON body limit 1 MB.
3. Tenant resolution: `/api/v1/platform/*` (bootstrap key) and `/api/v1/integration/v1/*` (API key → tenant) are tenant-less by host; everything else resolves the tenant from `tenant_domains` by Host (unknown host → 404).
4. `requireUser` verifies the RS256 access token (10 min, no role claims), loads the user and its `role_grants`; `requirePermission` checks the permission with scope.
5. Rate limiters per pool (login, activation, student saves, integration) in Redis.
6. The handler runs its service function inside `withTenantTx` — `SELECT set_config('app.tenant_id', ?, true)` then the work; RLS policy `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.bypass_tenant', true) = 'worker'`.
7. Errors are RFC 7807 problem objects `{type, title, status, code, detail, requestId}`; stack traces never leave the server.

### 2.4 Worker loops (`npm run worker`)

Outbox fan-out (`outbox_events` → `webhook_deliveries` / `mail_dispatches`), webhook delivery with backoff 1m/5m/30m/2h/6h/24h then DEAD, two mail lanes (TRANSACTIONAL first, BULK throttled) claimed with `FOR UPDATE SKIP LOCKED`, Power Automate callback timeout handling, forensic checks after seal, heartbeat sweep (90 s grace → `RECOVERY_PENDING`). Several workers may run concurrently.

### 2.5 Configuration (`.env.example`)

`DATABASE_URL` (app role `examos_app`, never a superuser) · `DATABASE_ADMIN_URL` (migrations only) · `EXAMOS_APP_DB_PASSWORD` · `REDIS_URL` · `JWT_ISSUER`, `JWT_AUDIENCE`, `JWT_PRIVATE_KEY_PEM`, `JWT_PUBLIC_KEY_PEM`, `JWT_KID`, `JWT_ACCESS_TTL_SECONDS=600`, `REFRESH_TTL_SECONDS=43200` (ephemeral RSA keys are generated outside production) · `APP_ENCRYPTION_KEY` (32-byte hex) · `PLATFORM_BOOTSTRAP_KEY` · `PUBLIC_PORTAL_URL` · `ACTIVATION_TTL_HOURS=48` · `ADMISSION_GRANT_TTL_SECONDS=300` · `LOG_LEVEL`.

### 2.6 Running locally

`npm install` → `docker compose -f infrastructure/docker/docker-compose.yml up -d` → `npm run migrate` → `npm run seed` → `npm run dev` (API :4000) and `npm run dev -w @examos/web` (Vite :5173, proxies `/api` with `Host: EXAMOS_TENANT_HOST`, default `demo.examos.local`) → `npm run worker`. `npm run demo` provisions the demo tenant below.

### 2.7 Tests and scripts

`npm test` (API: tenancy, auth, integration, mail, exam-flow e2e, recovery — real DB `examos_test` recreated in global setup, Redis db 9 flushed) · `npm test -w @examos/web` (render + reducer tests) · `npm run typecheck` · `npm run security:audit` · `npm run security:probes` (18 black-box probes via `node:http`, needs the demo server) · `npm run package` (source zip) · `node scripts/capacity-model.mjs` (capacity/cost model).

### 2.8 Demo tenant (`npm run demo`)

`admin@demo.local / Demo-Admin!2026` (TENANT_ADMIN) · `examcell@`, `chief@`, `evaluator@`, `controller@demo.local / Demo-Staff!2026` · `student01..12@demo.local / Demo-Student!2026` (UOS-1001…1012, CSE, BTECH-CSE, semester 5, register numbers 22CSE001…). Platform bootstrap key in the demo: `demo-platform-bootstrap-key-0123456789`.

---

## 3. Canonical model (`packages/contracts`)

### 3.1 Exam lifecycle

`DRAFT → PAPER_REVIEW → APPROVED → SCHEDULED → PRECHECK → LIVE → CLOSED → ARCHIVED`, with `CANCELLED` reachable from every pre-LIVE state and backwards moves `PAPER_REVIEW→DRAFT`, `APPROVED→PAPER_REVIEW`, `SCHEDULED→APPROVED`. Rules: PRECHECK may open at most 2 h before the window; allocation is refused while PRECHECK/LIVE; CLOSED seals every open attempt (expire + seal); exports of scripts are locked while PRECHECK/LIVE.

### 3.2 Attempt (pre-seal)

`ALLOCATED → PRECHECK_AVAILABLE → PRECHECK_RUNNING → READY → ADMITTED → ACTIVE ⇄ RECOVERY_PENDING / SUSPENDED → SUBMITTING → SUBMITTED`; terminal `EXPIRED`, `VOIDED_BY_AUTHORITY`. Sealed states (`SUBMITTED`, `EXPIRED`, `VOIDED_BY_AUTHORITY`) never accept an answer mutation again. Suspension kinds: `WARNING_THRESHOLD` (new epoch on resume), `TECHNICAL_HOLD` (epoch kept), `PROCTOR_MANUAL`.

### 3.3 Candidate pipeline (post-seal)

`ATTEMPT_SEALED → FORENSIC_CHECKS_RUNNING → FORENSIC_REVIEW_READY → ACADEMIC_MARKING_READY → EXAM_CELL_REVIEW → CANDIDATE_APPROVED → CONTROLLER_AUTHORIZED → PUBLISHED → (REVALUATION_PENDING → ACADEMIC_MARKING_READY)`. Exception states: `TECHNICAL_REVIEW_REQUIRED`, `IDENTITY_REVIEW_REQUIRED`, `INTEGRITY_HOLD`, `MARKING_MODERATION_REQUIRED`, `RESCHEDULE_APPROVED`, `INVALIDATED_BY_AUTHORIZED_DECISION`. Holds are allowed from the forensic and marking stages; an approval is bound to a result version and invalidated by a newer version.

### 3.4 Readiness checks

Codes: `IDENTITY_SESSION`, `ELIGIBILITY`, `CLIENT_VERSION`, `NETWORK_SAVE_ROUNDTRIP`, `CLOCK_SYNC`, `KEYBOARD_INPUT`, `CANVAS_INPUT` (optional), `CAMERA`, `MICROPHONE`, `CONSENT`. Sources: `SERVER`, `SECURE_CLIENT`, `PRACTICE`, `CLIENT_DECLARED`, `HUMAN`. Item statuses: `PENDING`, `PASS`, `REMEDIATE`, `UNVERIFIABLE`, `NEED_HELP`. Run statuses: `RUNNING`, `READY`, `REMEDIATE`, `REVIEW`, `EXPIRED`. Security-required checks (`IDENTITY_SESSION`, `ELIGIBILITY`, `CLIENT_VERSION`, `CONSENT`) can be waived only with `preflight:override-security` (Controller). Admission exception codes: `ACC_APPROVED`, `TECH_ALT_DEVICE`, `PROCTOR_OVERRIDE`, `POLICY_INCOMPATIBILITY` — scoped to checks, time-bounded, justified, audited.

### 3.5 Proctoring signals

Classes: `FOCUS_LOST`, `FULLSCREEN_EXIT`, `CONCURRENT_SESSION`, `DISALLOWED_APP_DETECTED`, `UNAPPROVED_DEVICE`, `NETWORK_ANOMALY`, `CAMERA_UNAVAILABLE`, `PERSON_POSSIBLE`, `MULTIPLE_PERSON_POSSIBLE`, `RECORDING_GAP`, `VISUAL_ANOMALY`, `OTHER_MANUAL`. Technical (never countable): `NETWORK_ANOMALY`, `CAMERA_UNAVAILABLE`, `RECORDING_GAP`. Server-verified countable: `CONCURRENT_SESSION` only. Incident statuses: `TECHNICAL`, `DISMISSED`, `PROCTOR_REVIEW`, `CONFIRMED_COUNTABLE_WARNING`. Decisions: `DISMISS`, `CONFIRM_WARNING`, `MARK_TECHNICAL`, `ESCALATE`, `INVALIDATE_REQUEST`. Default warning threshold 5; one warning per incident per epoch.

### 3.6 Mail

Categories → lanes: `ACCOUNT_ACTIVATION`, `ADMISSION_RECEIPT`, `TECHNICAL_HOLD_TICKET`, `SUSPENSION_ALERT`, `CANDIDATE_HOLD_NOTICE`, `SECURITY_ALERT` → TRANSACTIONAL; `REHEARSAL_REMINDER`, `PREFLIGHT_REMINDER`, `RESULT_PUBLISHED`, `EXAM_CELL_DIGEST` → BULK. Statuses `QUEUED → SENDING → ACCEPTED → DELIVERED | BOUNCED | FAILED`. Transports: `power-automate`, `graph`, `smtp-oauth2`, `smtp-relay`, `capture` (tests).

### 3.7 Integration events

`roster.sync.completed`, `exam.scheduled`, `exam.allocation.changed`, `attempt.admitted`, `attempt.submitted`, `candidate.held`, `candidate.approved`, `result.published`, `result.corrected`. Delivered as signed webhooks (`t=<unix>,v1=HMAC-SHA256(secret, t.body)`) and through a cursor feed. Results pull returns published results only, never proctoring data.

---

## 4. Data model

Twelve ordered migrations plus `…_0099_rls_and_app_role.ts` (creates role `examos_app`, grants, `ENABLE`/`FORCE ROW LEVEL SECURITY` on every `TENANT_TABLES` entry, append-only privileges and triggers).

| Migration | Tables | Purpose and key invariants |
| --- | --- | --- |
| 0001 tenants | `tenant_groups`, `tenants`, `tenant_domains` | not tenant-scoped; slug `^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$`; host → tenant |
| 0002 identity | `users`, `external_identities`, `role_grants`, `auth_sessions`, `one_time_tokens` | `external_identities(tenant_id, provider, external_id)` unique; `oidc:*` providers excluded from ERP identity (`erpIdentity`); refresh families with reuse detection; single-use activation tokens |
| 0003 tenant configs | `tenant_sso_configs`, `tenant_mail_configs`, `tenant_erp_connections`, `api_keys` | secrets sealed as `enc:`; API keys `exk_live_<keyId>_<secret>` stored SHA-256 with scopes, expiry, IP allowlist |
| 0004 academics | `schools`, `departments`, `programmes`, `courses`, `student_profiles`, `course_enrollments` | hierarchy for clutter-free filtering; register number in profile attributes |
| 0005 integration | `idempotency_keys`, `roster_sync_jobs`, `roster_sync_rows`, `integration_events`, `outbox_events`, `webhook_endpoints`, `webhook_deliveries` | batch ≤ 500 rows, per-row outcomes `CREATED/UPDATED/UNCHANGED/REJECTED/IDENTITY_CONFLICT`; outbox fan-out |
| 0006 mail | `mail_templates`, `mail_dispatches` | `dedupe_key` unique; lanes; versioned templates with per-tenant override |
| 0007 exams & attempts | `exams`, `hall_tickets`, `exam_allocations`, `exam_attempts`, `precheck_runs`, `precheck_items`, `precheck_practice_saves`, `admission_exceptions`, `admission_grants`, `answer_documents`, `answer_revisions`, `submission_manifests`, `attempt_event_log` | one attempt per allocation; grants consumed atomically (`UPDATE … WHERE consumed_at IS NULL RETURNING`); `answer_revisions` unique on `(attempt, question, revision)` and `(attempt, question, client_operation_id)`; event log is a per-attempt hash chain |
| 0008 proctoring | `proctor_incidents`, `proctor_events`, `warning_epochs`, `proctor_decisions`, `proctor_warnings`, `resume_grants` | events deduped by `(source, source_event_id)`, grouped per 120 s; warnings unique per `(incident, epoch)`; `proctor_events` updatable only on `incident_id` |
| 0009 candidates | `result_versions`, `candidate_review_packets`, `candidate_approvals`, `controller_publication_grants` | marks per question with exactly one explanation; approval references a result version; publication grant idempotent |
| 0010 audit & consent | `audit_events`, `consent_records` | per-tenant hash chain; consent by policy version |
| 0012 student records | `student_exam_records` | lifelong ledger; superseded rows kept on correction; views for semester and overall rollups |

Append-only: `audit_events`, `answer_revisions`, `proctor_warnings`, `attempt_event_log`, `submission_manifests`, `resume_grants`, `controller_publication_grants`.

**Phase 1 adds** `question_papers`, `paper_questions`, `paper_sets`, `paper_releases`; **Phase 3** `student_documents`; **Phase 5** `media_assets`, `evidence_items`; **Phase 6** `evaluator_assignments`, `moderation_samples`, `revaluation_requests`; **Phase 8** `platform_admins`, `mfa_enrollments` (all listed in §8 with columns).

---

## 5. API surface

Base `/api/v1`; full request/response shapes in `docs/api/route-map.md` (keep it current). Conventions: bearer access token; `x-device-session` header on every student exam request after admission; `Idempotency-Key` on integration batches; problem-object errors with stable `code`s (`TOKEN_INVALID`, `SESSION_REVOKED`, `ILLEGAL_TRANSITION`, `PRECHECK_NOT_OPEN`, `EXAM_NOT_STARTED`, `NOT_READY`, `PRECHECK_STALE`, `REVISION_CONFLICT`, `CONTENT_HASH_MISMATCH`, `ATTEMPT_NOT_ACTIVE`, `DEVICE_SESSION_MISMATCH`, `DEADLINE_PASSED`, `ALREADY_SUBMITTED`, `TECHNICAL_NOT_COUNTABLE`, `SECURITY_OVERRIDE_REQUIRED`, `EXPORT_LOCKED`, `EXAM_LOCKED`, `IDENTITY_CONFLICT`).

| Group | Routes (summary) |
| --- | --- |
| Public / auth | `GET /tenant`, `POST /auth/login|refresh|activate|logout`, `GET /auth/me`, `GET /auth/oidc/start`, `POST /auth/oidc/callback`, `GET /student/verify/:attemptId/:version` |
| Student | `GET /student/me/exams`, `GET /student/me/ledger`, `POST /student/attempts/:id/prechecks`, `POST /student/prechecks/:runId/items/verify|practice-saves|finalize`, `GET /student/attempts/:id/policy`, `POST …/entry-grants`, `POST …/admit`, `PUT|GET …/answers/:questionId`, `POST …/heartbeat|reconnect|submit`, `GET …/booklet`, `POST /proctor/events` (own attempt) |
| Exam Section / Controller | `GET|POST /exams`, `GET /exams/:id`, `POST /exams/:id/submit-for-review|approve|schedule|open-precheck|start|close|archive|cancel`, `POST /exams/:id/allocations`, `POST /exams/:id/hall-tickets`, `GET /exams/:id/readiness`, `POST /exams/:id/attempts/:attemptId/admission-exceptions`, `GET /exams/:id/candidates`, `GET /exams/:id/exports/scripts` |
| Candidates | `POST /candidates/:attemptId/forensics/run`, `POST …/result-versions`, `GET …/checklist`, `POST …/approvals`, `POST …/holds`, `POST …/holds/release`, `POST …/authorize-publication` |
| Proctor | `GET /proctor/incidents`, `POST /proctor/incidents/:id/decision`, `POST /proctor/attempts/:id/technical-holds|resume`, `GET /proctor/attempts/:id/timeline` |
| Tenant admin | `POST|GET /tenant/users`, `POST|DELETE /tenant/users/:id/roles`, `GET /tenant/users/:id/roles`, `PUT /tenant/mail-config`, `GET /tenant/mail-dispatches`, `PUT /tenant/sso-config`, `POST|GET|DELETE /tenant/api-keys`, `POST|GET /tenant/webhooks`, `GET /tenant/webhooks/deliveries`, `POST …/deliveries/:id/replay`, `GET /tenant/audit` |
| Integration (API key) | `PUT /integration/v1/roster/{academic-units,courses,persons,enrollments}` (batches with `Idempotency-Key`), `GET /integration/v1/events?cursor=`, `GET /integration/v1/results?…`, `POST /integration/v1/mail/callbacks`, webhook management |
| Platform | `POST /platform/tenants` (bootstrap key; to be replaced by platform admin accounts in Phase 8) |

---

## 6. End-to-end flows

Each flow lists the actor, the steps, what is written, what is emitted, and how it fails. "Tested" refers to the test file that proves it.

### F1 — Tenant onboarding (Tested: helpers/provisionTenant, tenancy.test.ts)

1. Platform operator calls `POST /platform/tenants` with the bootstrap key: creates `tenant`, its domains, the first TENANT_ADMIN user and an `ACCOUNT_ACTIVATION` mail (one-time token, 48 h).
2. Admin activates (`/activate?token=`), sets a password, signs in; configures SSO (`PUT /tenant/sso-config`: Entra or Google, domain allowlist), mail (`PUT /tenant/mail-config`: transport, sender `exam@<campus>`, sealed secrets), API keys and webhooks for the ERP, and roles for staff.
3. Mail templates are seeded per tenant (`DEFAULT_MAIL_TEMPLATES`, including `SECURITY_ALERT`); tenant overrides are versioned.
Failure: unknown host → 404; bootstrap key wrong → 401; slug invalid → 400.

### F2 — Identity and sign-in (Tested: auth.test.ts)

1. Password login: bcrypt verify with constant-work failure path; 5 failures → lockout (counter committed in its own transaction); 10-minute RS256 access token with no role claims + rotating refresh token (family).
2. SSO: `GET /auth/oidc/start` (PKCE + nonce + state in Redis) → IdP → `POST /auth/oidc/callback` verifies id_token against JWKS, matches an existing user by verified e-mail in the tenant's allowlisted domains — **no just-in-time provisioning**; unknown users are refused.
3. Every request re-reads `role_grants`; revoking a grant takes effect on the next request. Refresh reuse revokes the whole family (`auth.refresh_reuse_detected` audit).
Failure codes: `TOKEN_INVALID` (refresh once), `SESSION_REVOKED` (sign out).

### F3 — Roster and ERP sync (Tested: integration.test.ts)

1. ERP pushes `PUT /integration/v1/roster/academic-units|courses|persons|enrollments` in batches ≤ 500 with `Idempotency-Key`; each row is upserted by `(provider, externalId)` and gets an outcome; e-mail never merges identities (`IDENTITY_CONFLICT`).
2. A `roster_sync_jobs` row summarises the batch; `roster.sync.completed` is emitted to webhooks and the cursor feed.
3. Students get `student_profiles` (department, programme, semester, section, register number) and `course_enrollments`; staff are created as users with roles by the admin.
Not built: XLSX import UI (Phase 7), pull adapters `uos`/`generic-rest` (Phase 7), bounce reconciliation.

### F4 — Exam creation, paper, approval (Tested for exam lifecycle: exam-flow.e2e.test.ts; paper module Not Started → Phase 1)

1. Exam Section creates the exam (`POST /exams`: code, title, course, type, academic year, semester, max marks, security profile, duration, window, warning threshold, policy incl. `sebConfigKey`, `allowedClientBuilds`, consent purposes).
2. Question setter authors the paper (Phase 1) → `submit-for-review` (`DRAFT→PAPER_REVIEW`) → paper reviewer approves (`PAPER_REVIEW→APPROVED`) → Section schedules (`APPROVED→SCHEDULED`), which emits `exam.scheduled`.
3. Until Phase 1 lands, the workspace shows placeholder questions (`?questions=` or Q1..Q5) and marks are entered against those ids.

### F5 — Allocation and hall tickets (Tested: exam-flow)

1. `POST /exams/:id/allocations {studentExternalIds, provider, extraTimeMinutes}` allocates eligible students only (enrolment in the course, profile present); skipped rows carry a reason; refused while PRECHECK/LIVE (`EXAM_LOCKED`); emits `exam.allocation.changed`.
2. `POST /exams/:id/hall-tickets` issues `<examCode>-NNNN` numbers with a verification hash; the student sees the hall ticket per exam (`GET /student/me/exams` → drawer, printable) — PDF/QR in Phase 2.
3. Bulk reminders (`PREFLIGHT_REMINDER`, `REHEARSAL_REMINDER`) go through the BULK lane days before the exam.

### F6 — Readiness window (Tested: exam-flow, recovery)

1. Section presses **Open readiness** (`SCHEDULED→PRECHECK`, ≤ 2 h before the window). Students' attempts move `ALLOCATED→PRECHECK_AVAILABLE`.
2. Student opens the readiness screen: `POST /student/attempts/:id/prechecks {clientBuild}` creates a run and the check list from the profile; one step at a time: client version (SEB Config Key hash = SHA-256(request URL + key) verified server-side; allowed builds), clock (±120 s), keyboard functional sample (no WPM), optional canvas/stylus, practice save round-trip, consent (policy version), camera/mic (declared; `UNVERIFIABLE` on high tiers). `IDENTITY_SESSION` and `ELIGIBILITY` are server-measured.
3. `finalize` → `READY` (ready_until 45 min), `REMEDIATE` (one fix instruction at a time) or `REVIEW` (needs a human). The timer has not started; nothing counts against the student.
4. Exam Section watches the **Readiness Board** (`GET /exams/:id/readiness`, 10 s refresh): per student, per check, instruction, blocking checks, exceptions; helps in the hall; grants `admission-exceptions` scoped to checks with expiry — security checks only by a Controller (`SECURITY_OVERRIDE_REQUIRED` otherwise). Cyber-security side: client version, clock, consent and identity are visible per student.
5. Students who finished early re-run the 30-second check inside the last 45 minutes if their readiness expired.

### F7 — Admission (Tested: exam-flow, 6-way race)

1. Student presses **Enter exam**: `POST …/entry-grants` → one-time grant (TTL `ADMISSION_GRANT_TTL_SECONDS`); while the exam is still PRECHECK the student waits in the lobby (`EXAM_NOT_STARTED`, polling).
2. Section presses **Start** (`PRECHECK→LIVE`, `startedAt`). Only then `POST …/admit {grantToken}` consumes the grant atomically, creates epoch 1, binds the device (`deviceSessionId`), computes `deadlineAt` (duration + extra time), writes `ADMISSION_RECEIPT` (TRANSACTIONAL) and emits `attempt.admitted`.
3. Paper is served after admission only (Phase 1 adds the released set); until then the client renders placeholder questions.

### F8 — Writing (Tested: exam-flow, recovery; web: sync.test.ts, exam-workspace.test.tsx)

1. Editor blocks (`paragraph`, `equation`, `table`, `canvas`); the client applies ops locally, debounces 3 s, max wait 15 s, and sends `PUT …/answers/:questionId {clientOperationId, baseRevision, ops, contentSha256}`; the server locks the attempt (`FOR NO KEY UPDATE`), applies ops, verifies the canonical hash, inserts the revision, updates the document, returns a receipt. Duplicate operation ids return the same receipt; `REVISION_CONFLICT` makes the client refetch and rebase.
2. Heartbeat every 20 s returns status, server time, deadline, authorization generation; IP changes are logged as context, never as incidents.
3. Client-observable signals (`FOCUS_LOST`, `FULLSCREEN_EXIT`) are reported to `POST /proctor/events` for the student's own attempt; the server dedupes and groups them per 120 s into one incident for human review.
4. A request from a second device is a server-observed `CONCURRENT_SESSION` incident (priority 90) recorded in its own transaction, then refused (`DEVICE_SESSION_MISMATCH`).

### F9 — Interruptions (Tested: recovery.test.ts, exam-flow; `docs/case-matrix.md` has 20 cases)

Network drop < 90 s: local queue, same operation ids → same receipts. Wi-Fi → hotspot: allowed, logged. > 90 s without heartbeat: sweep → `RECOVERY_PENDING`, answers safe, clock runs (Controller may extend on resume). Reconnect: `POST …/reconnect` returns the server revision of every answer; client replays unsynced ops. Laptop dies: proctor technical hold → Chief Proctor resume with `rebindDevice` → first reconnect from the loaner binds it. Browser closed deliberately: expires at the deadline, sealed with all acknowledged answers. Clock tampering: readiness fails; the exam uses server time only. Wrong client: `CLIENT_VERSION` fails; Controller-only waiver.

### F10 — Proctoring decisions, suspension, resume, holds (Tested: exam-flow race, recovery)

1. Proctor console (5 s queue) shows incidents by priority with event counts, current warnings, epoch. `DISMISS`, `CONFIRM_WARNING`, `MARK_TECHNICAL`, `ESCALATE`, `INVALIDATE_REQUEST`; technical classes cannot be confirmed (`TECHNICAL_NOT_COUNTABLE`).
2. `CONFIRM_WARNING` inserts `proctor_warnings` (unique per incident per epoch); the fifth confirmed warning in an epoch suspends in the same transaction (`SUSPENDED`, `authorization_generation++`, `SUSPENSION_ALERT` mail). A concurrent save lands before (acknowledged) or is refused — never lost, never phantom.
3. Chief Proctor `resume` (reason, notes, deadline extension, device re-bind): `WARNING_THRESHOLD` suspension opens a new epoch at 0 with the history retained; technical holds keep the epoch. `GET /proctor/attempts/:id/timeline` shows events, warnings, epochs, holds and resumes.

### F11 — Submit, seal, close (Tested: exam-flow)

1. `POST …/submit {idempotencyKey}` → `SUBMITTING → SUBMITTED`: manifest (per-question revision + hash), `manifestSha256`, receipt, warning epochs closed, `candidate_review_packets` row in `ATTEMPT_SEALED`, `attempt.submitted` emitted with the ERP identity. Same key → same receipt; different key after sealing → `ALREADY_SUBMITTED`.
2. Deadline authority: saves after `deadlineAt` are refused (`DEADLINE_PASSED`); Section **Close** (`LIVE→CLOSED`) expires and seals every open attempt the same way.
3. The student's booklet is served only after publication (`NOT_PUBLISHED` before that); staff see the sealed booklet, and script exports are locked while PRECHECK/LIVE (F20). Printing/clipboard restrictions during the exam come from the SEB configuration (Phase 4).

### F12 — Forensic checks (Tested: exam-flow)

Worker (or `POST /candidates/:attemptId/forensics/run`) verifies manifest vs. revision ledger, event-log hash chain, incident/decision consistency, identity and eligibility; sets `academic_state`, `identity_state`, `integrity_state`, `media_quality_state`; moves to `FORENSIC_REVIEW_READY` or an exception state. `refreshIntegrityState` recomputes integrity at checklist/approval time so later decisions are reflected.

### F13 — Marking (Tested: exam-flow; web Evaluator screen In Progress)

Evaluator opens `/evaluate/:attemptId`: sees each question with the student's answer blocks (and the paper prompt after Phase 1), enters marks within range, criteria (optional), and **exactly one explanation per question**; `POST …/result-versions` creates version N (total, max), invalidates any live approval, and moves the candidate to `EXAM_CELL_REVIEW`. Evaluator identity is kept for the booklet's "validated by" line.

### F14 — Exam Cell approval (Tested: exam-flow)

Checklist (`GET …/checklist`): manifest ok, ledger complete, chain intact, incidents decided, identity & seat (`ELIGIBILITY_AND_SEAT`), marks complete; `publishable` true/false with details. `POST …/approvals {reviewedResultVersionId, reason, idempotencyKey}` → `CANDIDATE_APPROVED`; holds (`INTEGRITY_HOLD`, `TECHNICAL_REVIEW_REQUIRED`, `IDENTITY_REVIEW_REQUIRED`, `MARKING_MODERATION_REQUIRED`) with `CANDIDATE_HOLD_NOTICE` to the student and `candidate.held` to the ERP; release returns to review.

### F15 — Controller authorization and publication (Tested: exam-flow)

`POST …/authorize-publication {candidateApprovalId, idempotencyKey}` by a Controller: checks the approval is live and bound to the current result version, writes a `controller_publication_grants` row (append-only), upserts the ledger (superseding any previous row), sets `PUBLISHED`, queues `RESULT_PUBLISHED` (BULK) and emits `result.published` (or `result.corrected` when a published row already existed). Idempotent.

### F16 — Lifelong ledger and student profile (Tested: exam-flow)

`student_exam_records` holds one row per published result (superseded rows kept); `GET /student/me/ledger` returns records (exam type, year, semester, marks, grade, hall ticket, published at), semester rollups (exams, marks, max, percentage) and overall. Phase 3 turns this into the profile page with ID, hall tickets and charts (exam-wise, semester-wise cumulative, overall).

### F17 — Digital answer booklet and verification (Tested: exam-flow; web booklet.test.tsx)

`GET …/booklet` returns tenant, exam, student (name, register number, hall ticket), status, sealed at, manifest hash, questions with answer blocks, per-question marks/max/explanation/criteria, totals and version, validation (examiner, approved at, controller, published at), verification hash and URL. The web prints it as A4, one page per question, in the order question → answer → marks → explanation. `GET /student/verify/:attemptId/:version` (public) confirms validity, version, totals. Server-side PDF with QR is Phase 2.

### F18 — Mail pipeline (Tested: mail.test.ts)

Service writes `mail_dispatches` (category, lane, `dedupe_key`, template version, rendered HTML with escaping); worker claims by lane with `SKIP LOCKED`; transport `power-automate` POSTs to the flow's HTTP trigger (bearer), the flow sends from the shared mailbox ("Send an email from a shared mailbox (V2)") and calls back `POST /integration/v1/mail/callbacks` with the callback secret → `ACCEPTED`/`BOUNCED`; timeouts and transport errors back off and retry; admin sees `GET /tenant/mail-dispatches`. Quotas: 30 messages/min and 10,000 recipients/day per mailbox; 2,000 external recipients/day (Phase 7 adds an ACS/SES transport for external students). Guide: `docs/power-automate-exam-mail-flow.md`.

### F19 — Webhooks, event feed, results pull (Tested: integration.test.ts, exam-flow)

Outbox → `webhook_deliveries` per endpoint with HMAC signature and replay window; backoff to DEAD; admin replay. `GET /integration/v1/events?cursor=` for pull. `GET /integration/v1/results` returns published results by ERP identity only.

### F20 — Export lock, audit, security alerts (Tested: exam-flow, tenancy)

`GET /exams/:id/exports/scripts` during PRECHECK/LIVE → audit row + `SECURITY_ALERT` mail to Exam Section and Controller committed first, then `EXPORT_LOCKED` 403. Every privileged action writes `audit_events` (per-tenant hash chain, append-only); `GET /tenant/audit` for auditors.

### F21 — Corrections and re-evaluation (Partly built)

Transitions exist (`PUBLISHED→REVALUATION_PENDING→ACADEMIC_MARKING_READY`, `result.corrected`, ledger supersede). The request/approval workflow, fees, UI and notices are Phase 6.

---

## 7. Feature inventory and status (summary; evidence in `docs/DEVELOPMENT_CHECKLIST.md`)

| Area | Tested | In Progress | Not Started |
| --- | --- | --- | --- |
| Platform & tenancy | tenant groups/domains/host resolution; forced RLS; append-only audit/evidence; provisioning + activation; rate-limit pools; one super admin (password + TOTP); 3–4 staff logins per tenant with duty bundles | — | load proof of limiters |
| Identity | bcrypt login/lockout; RS256 + JWKS; refresh rotation/reuse; per-request grants; activation; OIDC (Entra/Google); sessions record ip/user agent | — | MFA for high-impact tenant roles |
| ERP integration | API keys; roster push; identity conflicts; idempotency; events/outbox/webhooks/dead-letter/replay; cursor feed; results pull | — | XLSX import UI; `uos`/`generic-rest` pull adapters |
| Mail | outbox/dedupe/lanes/backoff; Power Automate transport + callback; templates | Graph, SMTP OAuth2/relay (code present, not exercised) | bounce reconciliation; ACS/SES transport |
| Exam lifecycle | create; human-triggered conduct; allocation; hall tickets; export lock | — | question paper module; rooms/benches/seats |
| Readiness & admission | runs/items/sources; clock/keyboard/canvas/practice; system scan (server-derived findings); SEB Config Key; camera/mic honesty; readiness board; exceptions; one-time grant + lobby | — | face/PAD; media snapshot verification |
| Answers & submission | versioned saves; device binding; heartbeat/sweep/reconnect; atomic seal; deadline authority; whiteboard (all tools, one vector renderer for workspace/booklet/PDF); offline draft recovery UI | — | — |
| Proctoring | ingest/dedupe/grouping; decisions; fifth-warning atomic suspension; resume/epochs; technical hold; IP tracking with ipPolicy LOG/REVIEW/LOCK; in-exam device scans → review incidents; addresses and scans in the timeline and the evidence PDF | — | media buffer/clips/evidence viewer; AI signal producers |
| Post-exam | forensics; marks with one explanation; checklist/approval; holds; Controller publish; ledger; booklet JSON + verify | — | server PDF; AI rubric proposals; similarity |
| Web | login/SSO/activation/verify; student exams/hall ticket/lobby/ledger; readiness screen; exam workspace; booklet print; Exam Section (list/new/detail/conduct/allocations/hall tickets/readiness board/candidates) | evaluator screen; proctor console; tenant admin (smoke-tested, no render tests) | question paper rendering |
| Operations | capacity model; dependency audit (0 vulns); 26 black-box probes | worker loops (not load-tested) | load test; scale script (template); ACS transport; archival job; backups/PITR/observability; pen test/DAST/SAST/DPIA |

Counts across the checklist's 113 rows: 96 Tested, 5 In Progress, 12 Not Started (as of this document).

---

## 8. The plan to "done" (dependency order)

Effort is in agent-assisted engineering days for one engineer; they are planning estimates. Each phase ends with its tests green, the checklist updated and the demo seed extended so the whole chain can be walked end to end.

### Phase 0 — Baseline in Antigravity (0.5 day)

Set up per §0.1; run everything green; read `docs/api/route-map.md` and `docs/case-matrix.md`; produce no code. Acceptance: `npm test`, `npm test -w @examos/web`, `npm run typecheck`, `npm run security:probes` all pass locally; checklist unchanged.

### Phase 1 — Question paper module (6–8 days) — unblocks real exams

**Scope.** Authoring, review and approval of papers; sealed storage; release at admission; rendering in the workspace, evaluator screen and booklet; marks validated against the paper.

**Data.**
- `question_papers (id, tenant_id, exam_id, version, status DRAFT|REVIEW|APPROVED|SUPERSEDED, title, instructions, total_marks, sections jsonb, sealed_sha256, encrypted_body bytea NULL, created_by, submitted_at, approved_by, approved_at)` — one APPROVED per exam.
- `paper_questions (id, tenant_id, paper_id, question_id text, section_code, number, kind DESCRIPTIVE|MCQ|NUMERIC|DRAWING, prompt jsonb (blocks: paragraph/equation/table/image refs), options jsonb NULL, max_marks numeric, rubric jsonb NULL (criteria [{code,max,description}]), expected_answer jsonb NULL (never served to students), attachments jsonb)`.
- `paper_sets (id, tenant_id, paper_id, set_code, question_order jsonb)` — optional shuffling per set; `paper_releases (id, tenant_id, attempt_id, paper_id, set_code, released_at)` — written at admission, unique per attempt.
- Add all four to `TENANT_TABLES`; `paper_releases` append-only.

**Rules.** Paper content is encrypted at rest with `APP_ENCRYPTION_KEY` until the exam is LIVE; reading an approved paper before LIVE is audited (`paper.viewed`). The exam cannot move `PAPER_REVIEW→APPROVED` without an APPROVED paper whose `total_marks == exams.max_marks`. Students receive the paper only via `GET /student/attempts/:id/paper` while the attempt is `ACTIVE`/`RECOVERY_PENDING`/`SUSPENDED` and the exam is LIVE; the response never includes `expected_answer` or rubric. `result-versions` must reference the paper's question ids and respect `max_marks` per question.

**API.** `GET|PUT /exams/:id/paper` (QUESTION_SETTER with `paper:write`; add `paper:write`, `paper:review` permissions), `POST /exams/:id/paper/submit-for-review`, `POST /exams/:id/paper/approve|reject` (PAPER_REVIEWER), `POST /exams/:id/paper/sets` (optional), `GET /student/attempts/:id/paper`, `GET /candidates/:attemptId/paper` (evaluator/examcell view incl. rubric).

**Web.** `/examcell/exams/:id/paper` editor (sections, questions, marks, rubric; block editor reused from the workspace), review screen with approve/reject + comments; workspace reads the released paper (question navigator, marks per question, attachments); evaluator sees prompt + rubric beside the answer; booklet prints the prompt before the answer.

**Tests.** approval gate on exam transition; encryption until LIVE; audit on early view; student cannot fetch before admission/after seal; marks outside `max_marks` refused; set release unique per attempt; render tests for editor and workspace navigator. Also DOCX/PDF ingestion is **out of scope** here (Phase 7 nice-to-have); authoring is in-app.

**Acceptance.** Demo seed creates an approved 5-question paper; a full run (readiness → admit → write → submit → mark → approve → publish → booklet) shows real question text everywhere.

### Phase 2 — Server-side PDF and QR verification (3 days)

Render the existing booklet and hall-ticket layouts server-side with Playwright/Chromium (same HTML as the web, deterministic fonts), store in object storage (`documents` bucket; Azure Blob or S3-compatible; local disk in dev), record `sha256` in `submission_manifests.metadata`/`hall_tickets`, embed a QR with the verification URL. Endpoints: `GET …/booklet.pdf` (student after publication; staff after CLOSED), `GET /student/me/exams/:examId/hall-ticket.pdf`, restricted `GET /candidates/:attemptId/evidence.pdf` (SECURITY_AUDITOR/CONTROLLER; includes timeline, incidents, decisions). Tests: hash stability, access control, lock during PRECHECK/LIVE. Checklist rows: "Booklet PDF rendering" → Tested.

### Phase 3 — Student profile, ID and analytics (3–4 days)

Profile page (`/student/profile`): photo (upload with consent; `student_documents (id, tenant_id, user_id, kind PHOTO|ID_CARD|HALL_TICKET, blob_ref, sha256, created_at)`), register number, programme/department/semester, ID card (printable, QR → public verify of identity record), hall tickets per exam, ledger charts: exam-wise, semester-wise cumulative, overall (Recharts or hand-rolled SVG; dataviz rules in the web app's chart helpers). HOD/REPORT_VIEWER dashboards by school/department/programme with the same rollups (no personal proctoring data). Tests: rollup correctness with corrected results; access scoping by department.

### Phase 4 — Secure client and cheating mitigation (4–5 days)

- SEB configuration generator: `POST /exams/:id/seb-config` builds the `.seb` plist (allowed URL = tenant host only; block clipboard, print, screen capture, virtual machines, remote sessions; kiosk) and stores the computed Config Key in the exam policy; students download it from the exam card (SECURE_BYOD) — the readiness check already verifies the key.
- Client build registry (`allowedClientBuilds`) UI; MANAGED_ENDPOINT attestation stub (device certificate or lab IP range) → `CLIENT_VERSION` source `SECURE_CLIENT`.
- Download/print discipline: the student booklet stays publication-gated (already enforced); staff export outside CLOSED → existing export lock; add a `booklet.downloaded` audit row and an examiner notice on every staff download before publication (configurable).
- Client-side signals extended: `DISALLOWED_APP_DETECTED`/`UNAPPROVED_DEVICE` from the SEB process list (SEB reports via its API where supported) — still human-review only.
Tests: generated config key matches the verification path; policy toggles; audit on download. Documentation: `docs/seb-rollout.md` (device matrix decided with IT — §11).

### Phase 5 — Media and evidence pipeline, Tier 1 (6–8 days; DPIA first — §11)

- Consent purposes per profile; `media_assets (id, tenant_id, attempt_id, kind SNAPSHOT_CAMERA|SNAPSHOT_SCREEN|CLIP, captured_at, blob_ref, sha256, bytes)`; `evidence_items (id, tenant_id, incident_id, media_asset_id, note)`.
- Signed upload URLs (Blob SAS / S3 presigned) issued per attempt; client captures a webcam/screen JPEG at readiness (turns `CAMERA` into a server-verified check), every 60 s, and on each incident; rolling 5-second clips are Tier 2 and stay out of scope.
- Evidence viewer in the proctor console and the Exam Cell checklist; retention job (hot for the appeal window, then archive); `media_quality_state` computed by forensics (gaps, missing frames).
- Face reference / 1:1 match / PAD only through a vendor API behind a feature flag, with a human referee; never auto-countable.
Tests: upload URL scoping, hash verification, retention, access control (student never sees others' media; evaluators never see media). Capacity: ~11 GB per 1,000-student sitting (see `docs/capacity-and-budget.md`).

### Phase 6 — Evaluation at scale, moderation, revaluation (6–8 days)

- `evaluator_assignments (id, tenant_id, exam_id, evaluator_user_id, attempt_id, assigned_at, status)`: assignment by course/department with workload balancing; anonymised marking (evaluator sees attempt id and register-number hash, never name) for external exams.
- Double evaluation for `SEM_EXTERNAL`: two versions; difference above threshold → `MARKING_MODERATION_REQUIRED` → MODERATOR third version; `moderation_samples` for random sampling.
- Revaluation: `revaluation_requests (id, tenant_id, attempt_id, requested_by, reason, fee_ref, status REQUESTED|APPROVED|REJECTED|DONE)` → `PUBLISHED→REVALUATION_PENDING→ACADEMIC_MARKING_READY` → new version → approval → publish as `result.corrected`; student notice.
- Gate E (optional, flag): AI rubric-based proposals shown as suggestions the evaluator must accept per question (the explanation stays human-written); answer similarity across attempts of one exam (MinHash/shingles) producing `INTEGRITY_HOLD` candidates for human adjudication — never automatic.
Tests: assignment uniqueness, anonymisation, threshold logic, revaluation state chain, corrected ledger rollups.

### Phase 7 — ERP adapters, XLSX import, mail completeness (4–5 days)

- `uos` pull adapter and `generic-rest` adapter behind `tenant_erp_connections` (schedule, mapping, dry-run); same roster service as push.
- XLSX import UI (download templates, upload, preview, per-row outcomes) using the roster service with `source=XLSX`.
- Bounce reconciliation from the shared mailbox (Graph read of NDRs) → `BOUNCED`; ACS Email / SES transport for the BULK lane where recipients are external; mail quota dashboard.
Tests: adapter mapping, dry-run, XLSX validation, transport selection by lane.

### Phase 8 — Platform administration and operations (5–6 days)

- Platform admin accounts (`platform_admins`) replacing the bootstrap key; tenant lifecycle (suspend, rotate domains).
- MFA (TOTP) for CONTROLLER, SYSTEM_ADMIN, TENANT_ADMIN (`mfa_enrollments`); step-up on publication and security waivers.
- Secrets in a KMS/vault (`vault:` reference scheme); RS256 key rotation runbook (`JWT_KID`).
- Observability: OpenTelemetry traces/metrics, exam-day dashboard (req/s, p95, DB connections, outbox depth, mail lanes, sweep lag), alerts.
- Backups/PITR drills, revision archival job, `scale-exam-day.sh` executed against a staging subscription and marked Tested only after a real run.
Tests: MFA enforcement on protected routes, admin account lifecycle, archival idempotency.

### Phase 9 — Hardening, performance and launch (6–10 days + external vendors)

- Gate G load test: k6 scenarios (readiness burst 1,500; writing steady state 3,000 with the real save/heartbeat/signal mix; submit burst); fix hotspots; publish measured p95 in `docs/capacity-and-budget.md`.
- DAST (ZAP) and SAST (CodeQL/Semgrep) in CI; CSP for the SPA; webhook SSRF allow/deny list; independent penetration test and fixes; DPIA sign-off; WCAG 2.1 AA audit of student screens; render tests for evaluator/proctor/admin; UX polish pass.
- Pilot: a PRACTICE exam with real students, then a MID_1 in BASIC_BROWSER, then SECURE_BYOD. University acceptance per feature → rows move to **Completed**.

### Phase order and dependencies

```
P0 → P1 (paper) → P2 (PDF/QR) → P3 (profile/analytics)
P1 → P4 (secure client) → P5 (media Tier 1, needs DPIA decision)
P1 → P6 (evaluation at scale)
P7 (ERP/XLSX/mail) can run in parallel with P3–P6
P8 (platform/ops) before P9 (hardening/launch)
```

---

## 9. Engineering rules (long form of `AGENTS.md`)

1. Contracts first: enums and Zod schemas in `packages/contracts` are the only vocabulary; the DB check constraints import them; the UI imports them.
2. Every business table: `tenant_id uuid NOT NULL REFERENCES tenants(id)`, listed in `TENANT_TABLES`; RLS enabled and forced; the app role has no BYPASSRLS.
3. Every service call runs inside `withTenantTx`/`withWorkerTx`; never pass `db` to a service, pass `trx`.
4. Locks: `forNoKeyUpdate()` on attempt/candidate rows; never `FOR UPDATE` on rows that other transactions insert FK children for (deadlocks).
5. Record-then-refuse: evidence writes that must survive a refusal go in a separate `withTenantTx` before the throw.
6. Idempotency keys on every mutating staff action and every client write; duplicates return the original result, a different body with the same key is 409.
7. Append-only tables are never updated or deleted by code; corrections are new rows that supersede.
8. Never trust the client: timestamps, device claims, check results, question ids and marks are validated server-side; `UNVERIFIABLE` is a legitimate status.
9. Errors: throw `AppError(code, status, detail)`; codes are stable strings documented in the route map; never leak stack traces.
10. Mails and events are written in the same transaction as the business change (outbox); workers deliver.
11. Tests run against the real PostgreSQL and Redis; no mocking of the database. Each invariant that depends on concurrency has a race test (`Promise.all` of N requests).
12. Web: one status-driven action per object; accessible custom components (`apps/web/src/ui`); no `localStorage` for tokens; TanStack Query for server state; keep the student path in the main bundle, staff screens lazy.
13. Keep `docs/api/route-map.md`, `docs/DEVELOPMENT_CHECKLIST.md` and ADRs current in the same change; add an ADR when a decision in §11 is taken.
14. Dependencies: `npm audit` must stay at 0 production vulnerabilities; upgrade rather than ignore.
15. Never commit secrets; `.env` is ignored; demo credentials are only for `*.local` tenants.

---

## 10. Definition of done and PR checklist

- [ ] Contracts updated and exported; DB constraints reference them.
- [ ] Migration added, `TENANT_TABLES`/`APPEND_ONLY_TABLES` updated, RLS verified by a test (`count = 0` without tenant context).
- [ ] Service + routes with permissions, idempotency and problem-object errors.
- [ ] Tests: happy path, refused path, race where relevant; `npm test` and `npm test -w @examos/web` green; `npm run typecheck` clean.
- [ ] Web screen with render test; keyboard and screen-reader pass for student-facing screens.
- [ ] Route map, checklist (status + evidence), ADR if applicable, demo seed extended.
- [ ] `npm run security:audit` 0 vulnerabilities; probes still 18/18.
- [ ] Nothing marked Completed.

---

## 11. Decisions requiring authorization (ask before building)

| Decision | Why it blocks | Default if unanswered |
| --- | --- | --- |
| Certified device/SEB matrix and whether MANAGED_ENDPOINT labs exist | Phase 4 attestation and the `.seb` policy | SECURE_BYOD with SEB only; no attestation |
| DPIA / consent policy for camera and microphone capture (DPDP Act) | Phase 5 cannot capture media without it | Tier 0 (signals only) stays; Phase 5 deferred |
| Double evaluation and moderation thresholds for SEM_EXTERNAL | Phase 6 logic | single evaluation + random 10 % moderation sample |
| Revaluation fee and window | Phase 6 workflow | 7-day window, fee recorded as a reference only |
| Retention: appeal window for revisions and media | Archival job (Phase 8) | 1 academic year hot, then archive; final records forever |
| External student mailboxes (Google Workspace campuses) | Phase 7 transport choice | Power Automate + Exchange for internal; ACS Email for BULK external |
| Platform admin model (who provisions tenants) | Phase 8 | university IT holds platform admin accounts with MFA |
| Grading bands per programme | `gradeFor` is a default band table | keep defaults; make per-tenant configurable in Phase 6 |

---

## 12. Working with Antigravity

- **Files it reads:** `AGENTS.md` (root; cross-tool rules), `.agents/rules/*.md` (modular rules, ≤ 12,000 characters each), `.agents/workflows/*.md` (slash commands). Global rules live in `~/.gemini/GEMINI.md` on the workstation (keep them empty for this project; everything is in-repo).
- **Workflows provided:** `/implement-feature` (the §0.2 recipe as steps), `/verify` (typecheck, tests, audit, probes), `/exam-day-rehearsal` (seed, walk the chain, check mail/webhooks/health).
- **Per-phase prompt template:**

> Implement §8 Phase N "<title>" from `docs/ANTIGRAVITY_CONTINUATION_PLAN.md`. Follow `/implement-feature`. Create the tables listed, with `tenant_id`, RLS and append-only rules; add contracts; implement the service and routes with permissions and idempotency; write tests for the happy path, the refused path and the race; build the web screens with render tests; update route map, checklist and demo seed. Stop and ask only for a §11 decision. Report: what was built, test counts before/after, checklist rows changed.

- **Review prompt:** "Review the diff against §9 rules and §0.3 non-negotiables; list every place where client input is trusted, a query runs outside `withTenantTx`, a status changes without `assertTransition`, or a refusal loses evidence."
- **What not to let the agent do:** mark Completed; mock the database in tests; add a UI library; store tokens in `localStorage`; auto-count any signal; skip the checklist.

---

## Appendix A — Glossary

Attempt (one student's sitting of one exam) · Candidate packet (post-seal review record) · Epoch (warning counter window; resets on resume after suspension) · Readiness run (the 15-minute check) · Admission grant (one-time token to enter) · Seal (the moment answers become immutable) · Manifest (per-question revision + hash list signed by the seal) · Ledger (lifelong published results) · Lane (TRANSACTIONAL vs BULK mail) · Tenant (campus).

## Appendix B — Demo walkthrough (the click path every phase must keep working)

1. `npm run demo` → sign in as examcell → `/examcell/exams/new` → create MID_1, BASIC_BROWSER → submit-for-review → approve → schedule → allocate student01..12 → issue hall tickets.
2. Open readiness → student01 runs the check (`/student` → Get ready) → readiness board shows READY; student02 fails clock → REMEDIATE; grant exception as controller.
3. Start exam → students enter; type and draw; switch Wi-Fi; close tab; reconnect; proctor confirms warnings; chief resumes.
4. Submit; close exam; forensics; evaluator marks with explanations; examcell approves; controller publishes; student sees ledger and booklet; `/verify/:attemptId/:version` valid; ERP webhook delivered; mails in `/admin` mail log.
