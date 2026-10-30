# AGENTS.md — rules for any coding agent working on SMRU ExamOS

Read `docs/ANTIGRAVITY_CONTINUATION_PLAN.md` (the full handover: product, roles, model, flows, status, remaining plan) before changing anything. Status of every feature lives in `docs/DEVELOPMENT_CHECKLIST.md`; routes in `docs/api/route-map.md`; decisions in `docs/ADRs/`.

## What this is
Multi-tenant, AI-assisted university examination platform (St. Mary's University; each campus = tenant) integrated with the ERP (UOS) through a simple API. Node 22 + TypeScript, Express 4, PostgreSQL 16 + Knex, Redis 7, Zod 4, JWT RS256 + bcrypt, Microsoft/Google OIDC, Nodemailer; React 19, Vite, Tailwind 4, TanStack Query, React Router 7, custom accessible components (no Radix/shadcn); Vitest + Supertest / Testing Library. Do not substitute any of these.

## Commands
- Setup: `npm install` (`.npmrc` has `legacy-peer-deps=true`), copy `.env.example` → `.env`, start PostgreSQL 16 + Redis 7 (`infrastructure/docker/docker-compose.yml`), `npm run migrate`, `npm run seed`.
- Run: `npm run dev` (API :4000), `npm run dev -w @examos/web` (Vite :5173), `npm run worker`, `npm run demo` (demo tenant; credentials in the plan §2.8).
- Verify: `npm run typecheck`, `npm test` (API, real DB `examos_test`), `npm test -w @examos/web`, `npm run security:audit`, `npm run security:probes` (needs the demo server).

## Non-negotiables
1. Never fake security. A check the server cannot measure is `UNVERIFIABLE`, never `PASS`. Nothing client-reported is authoritative (timestamps, device claims, check results, question ids, marks).
2. Every tenant-table access runs inside `withTenantTx(db, tenantId, fn)` (worker: `withWorkerTx`). Every business table has `tenant_id`, is in `TENANT_TABLES` (`packages/db/src/index.ts`) and has forced row-level security. Never point `DATABASE_URL` at a superuser.
3. Every status change goes through `assertTransition(...)` with the tables in `packages/contracts/src/state-machines.ts`. No second vocabulary: enums live in `packages/contracts/src/enums.ts` and are imported by DB constraints, Zod and the UI.
4. Append-only tables (`audit_events`, `answer_revisions`, `proctor_warnings`, `attempt_event_log`, `submission_manifests`, `resume_grants`, `controller_publication_grants`) are never updated or deleted; corrections are new superseding rows.
5. Humans decide: no proctoring signal becomes a countable warning without a named human's decision, except the server-observed `CONCURRENT_SESSION`; technical classes are never countable; suspension happens only on the Nth confirmed warning inside one transaction.
6. Exams are conducted by people: readiness opens, the exam starts and closes only on the Examination Section's action; the server enforces the deadline.
7. Record, then refuse: evidence that must survive a refusal (second device, export during exam, failed login, refresh reuse) is committed in its own transaction before throwing.
8. Idempotency wherever it hurts: client operation ids on saves, idempotency keys on submits/decisions/approvals/publication, `Idempotency-Key` on roster batches, `dedupe_key` on mails, event ids on webhooks.
9. Secrets are sealed (`enc:` AES-256-GCM / `env:` references) and never returned by any API. Never commit `.env`.
10. Status honesty: *Not Started* · *In Progress* · *Tested* (automated test against the real DB) · *Completed* (tested **and** accepted by the university). Never mark Completed. Never mark Tested without a passing test file named in the checklist.

## The change recipe (every feature, in this order)
contracts (`packages/contracts`) → migration (`packages/db/migrations`, add table to `TENANT_TABLES`/`APPEND_ONLY_TABLES`, RLS) → service (`apps/api/src/modules/<m>/service.ts`, functions take `(deps, trx, tenantId, …)`) → routes (`requireUser`, `requirePermission`, idempotency, `AppError(code, status)`) → tests (`apps/api/test`, happy + refused + race) → web (`apps/web/src/features/<area>`, render test in `apps/web/test`) → docs (`docs/api/route-map.md`, `docs/DEVELOPMENT_CHECKLIST.md`, ADR if a decision changed, demo seed extended).

## Patterns to copy
- Locks: `.forNoKeyUpdate()` on attempt/candidate rows (never `FOR UPDATE` where other transactions insert FK children).
- Errors: RFC 7807 problem objects with stable `code`s; no stack traces to clients.
- Outbox: mails and integration events are written in the same transaction as the business change; workers deliver (`FOR UPDATE SKIP LOCKED`).
- Web: one status-driven action per object; TanStack Query for server state; tokens in memory/sessionStorage only; student path in the main bundle, staff screens lazy.
- Tests: no database mocking; concurrency invariants get a `Promise.all` race test.

## Do not
- Add a UI component library, an ORM, or a second state vocabulary.
- Auto-count any signal, auto-publish any result, or auto-provision users from SSO.
- Put role claims in JWTs, tokens in `localStorage`, or secrets in responses.
- Skip the checklist or widen scope beyond the current phase in `docs/ANTIGRAVITY_CONTINUATION_PLAN.md` §8.
- Ask the user anything except for a decision listed in the plan's §11.

## Where to start
Follow the plan's §0.1 (baseline green), then §8 Phase 1 (question paper module). Workflows: `/implement-feature`, `/verify`, `/exam-day-rehearsal` in `.agents/workflows/`.
