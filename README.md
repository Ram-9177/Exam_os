# SMRU ExamOS — foundation release (v3.1 architecture)

Multi-tenant university examination platform for the St. Mary's Group. This repository contains the **tested backend vertical slice** and the **web application** described in *SMRU ExamOS — Architecture Review v3.1* (the companion document), built on the mandated stack:

- **Backend:** Node.js 22 + TypeScript, Express 4, PostgreSQL 16 + Knex, Redis 7, Zod, RS256 JWT + bcrypt, OpenID Connect (Microsoft Entra ID / Google Workspace), Nodemailer, Vitest + Supertest.
- **Frontend:** React 19 + TypeScript, Vite, Tailwind CSS 4, TanStack Query, React Router 7, custom accessible components, Vitest + Testing Library (`apps/web`).

What is implemented and **tested against a real PostgreSQL 16 and Redis 7** (no mocks): tenancy with row-level security, identity/auth, the ERP-agnostic Simple Integration API (roster push, signed webhooks, event feed, results pull), exam mail through a Power Automate shared-mailbox flow (with Graph/SMTP fallbacks), exam lifecycle with human-triggered conduct, hall tickets, the 15-minute readiness check with server-measured checks and Safe Exam Browser Config-Key verification, one-time admission grants, versioned/idempotent answer saves bound to one device, proctor signal ingest → incidents → human decisions → atomic fifth-warning suspension → resume with epochs, technical holds and loaner re-binding, recovery after network loss, export lock, atomic sealing, forensic completeness checks, examiner marks with one explanation per question, Exam Cell per-candidate approval, Controller publication, the lifelong student ledger, the digital answer booklet and result verification.

What is **not** implemented yet is listed honestly in `docs/DEVELOPMENT_CHECKLIST.md` (media/evidence pipeline, face/PAD, AI grading, similarity analysis, PDF rendering, SEB config signing UI, XLSX import UI, load testing).

## Quick start

```bash
# 1. PostgreSQL 16 + Redis 7 (either local services or the compose file)
docker compose -f infrastructure/docker/docker-compose.yml up -d

# 2. install
npm install

# 3. configure
cp .env.example .env            # edit DATABASE_URL / DATABASE_ADMIN_URL / REDIS_URL / PLATFORM_BOOTSTRAP_KEY

# 4. migrate + seed (runs as the admin/owner role; creates the non-superuser examos_app role and RLS policies)
npm run migrate && npm run seed

# 5. run
npm run dev        # API on :4000
npm run worker     # outbox, webhooks, mail lanes, forensics, heartbeat sweep
npm run demo       # seeds a complete demo tenant (users, roster, two exams) and prints the credentials
npm run test       # 48 integration tests against the real database (creates examos_test)
npm run typecheck
npm run package    # source zip without node_modules
npm run security:audit   # npm audit, production tree (0 known vulnerabilities at hand-over)
npm run security:probes  # 26 black-box probes against a demo-seeded server
```

Security status and what an independent assessment still has to cover: `docs/security-review.md`.

Then `npm run dev -w @examos/web` and open http://localhost:5173 (the Vite proxy forwards `/api` to the API with the tenant host).

### Bootstrap the first tenant

```bash
curl -X POST http://localhost:4000/api/v1/platform/tenants \
  -H "x-platform-key: $PLATFORM_BOOTSTRAP_KEY" -H "content-type: application/json" \
  -d '{"slug":"smru","name":"St. Mary'"'"'s University","domains":["exam.smru.edu.in","localhost"],"adminEmail":"it@smru.edu.in","adminFullName":"IT Manager","timezone":"Asia/Kolkata"}'
```

The tenant admin receives an activation mail (queued in `mail_dispatches`; configure the tenant mail transport first with `PUT /api/v1/tenant/mail-config`, or read the activation link from the table in development). Everything after that is done through the web app or the API; see `docs/api/route-map.md`.

The API resolves the **tenant from the request Host header** (`tenant_domains`), so every campus is a hostname (`exam.smru.edu.in`, `exam.guntur.smru.edu.in`); integration calls resolve the tenant from the API key instead.

## Repository layout

```
packages/contracts   canonical enums, state machines, Zod schemas (shared by API and web)
packages/db          Knex migrations (12), seed, tenant-scoped transaction helpers
apps/api             Express 4 API + background worker + integration tests
apps/web             React 19 web application
docs/                checklist, ADRs, Power Automate flow guide, case matrix, route map
infrastructure/      docker-compose for local PostgreSQL/Redis
```

## Security model in one paragraph

PostgreSQL is the only authority. Every business table carries `tenant_id` and is protected by forced row-level security keyed on a transaction-local setting; the API connects as a non-superuser role with no bypass and append-only privileges on evidence tables. Authorization is re-read from `role_grants` on every request (tokens carry no roles). Attempt state changes happen in single transactions holding a row lock; a cached “ACTIVE” can never authorize a write. Nothing client-reported is trusted as a pass: readiness checks are server-measured where possible and stored with their source, the secure client is verified by the SEB Config Key hash, a second device is a server-observed incident, and no AI or server rule ever counts a warning — only a named human decision does.

## Documents

- `docs/DEVELOPMENT_CHECKLIST.md` — status of every feature (Tested only when a test exists).
- `docs/ADRs/` — tenancy, integration API, mail transport, canonical state machines, no-client-trust.
- `docs/power-automate-exam-mail-flow.md` — how to build the exam mailbox flow.
- `docs/case-matrix.md` — interruption and misconduct scenarios and what the system does.
- `docs/api/route-map.md` — every route with request/response shapes.
- `docs/ANTIGRAVITY_CONTINUATION_PLAN.md` — complete handover and remaining plan (roles, model, flows, status, phases); `AGENTS.md` and `.agents/` carry the agent rules and workflows.
- `docs/capacity-and-budget.md` — peak-only sizing and cost model (1,000–3,000 concurrent students); regenerate with `node scripts/capacity-model.mjs`.
