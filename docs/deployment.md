# Deployment notes (foundation release)

## Topology
- One API deployment (`apps/api`, Express 4) behind a reverse proxy that terminates TLS and forwards the **Host** header unchanged; the tenant is resolved from it (`tenant_domains`). Set `trust proxy` (already enabled in production) so client addresses are correct.
- The web app (`apps/web`, static Vite build) is served on the **same hostname** as the API for each tenant (e.g. `exam.smru.edu.in` serves the SPA and `/api/v1/*`). Same-origin means no CORS surface and the Safe Exam Browser allowlist needs one domain per tenant.
- At least one worker process (`npm run worker`): outbox fan-out, webhook delivery, two mail lanes, forensic checks, heartbeat sweep. Several workers may run concurrently (claims use `FOR UPDATE SKIP LOCKED`).
- PostgreSQL 16 (primary + tested failover), Redis 7 (presence, rate limits, OIDC state, heartbeat keys — never authoritative), object storage and the media pipeline are Gate C work.

## Database roles
- Migrations run as the owner/admin role (`DATABASE_ADMIN_URL`).
- The API and worker run as `examos_app` (`DATABASE_URL`): no superuser, no BYPASSRLS, forced row-level security, append-only privileges on evidence tables. Never point `DATABASE_URL` at a superuser.

## Secrets
- `JWT_PRIVATE_KEY_PEM` / `JWT_PUBLIC_KEY_PEM` (RS256), `APP_ENCRYPTION_KEY` (AES-256-GCM for sealed config secrets and webhook secrets), `PLATFORM_BOOTSTRAP_KEY` (replace with platform admin accounts before production).
- Tenant secrets (flow URL, flow token, callback secret, SSO client secret) are sealed through the admin API and stored as `enc:` references. A tenant API call may only supply the secret value (sealed on write) or an `enc:` reference; `env:NAME` references are reserved for deployment-managed configuration set by operators (a tenant admin must never be able to point a transport at the deployment's own keys); `vault:` is reserved for the KMS adapter.

## Browser session model
Access tokens (10 min, RS256) are held in memory/sessionStorage by the SPA and sent as a bearer header; refresh tokens rotate with reuse detection. This was chosen over HttpOnly cookies because the exam client (Safe Exam Browser) and the ERP integration share the API, and because a cookie model would need CSRF defences on every mutation. Mitigations: strict CSP on the SPA, no `localStorage`, short token life, family revocation.

## Safe Exam Browser
For `SECURE_BYOD` exams set the exam policy `sebConfigKey` to the Config Key of the `.seb` file issued to students; the readiness check verifies `X-SafeExamBrowser-ConfigKeyHash` = SHA-256(absolute request URL + Config Key). The `.seb` file must allow only the tenant hostname. Generating and signing `.seb` files from ExamOS is a backlog item; until then IT issues them from the SEB config tool and pastes the key into the exam policy.

## Exam day (2,000+ students writing for 4 hours)

Measured with `apps/api/scripts/load-smoke.ts` (readiness → admission → heartbeat/save/scan mix) and the invariant tests in `apps/api/test/scale-invariants.test.ts`; numbers in `docs/reviews/2026-10-30-exam-day-audit.md`.

- **Processes.** Run at least two API processes behind the proxy (`DB_POOL_MAX=20` each, PgBouncer in front of PostgreSQL) and one worker. The worker now owns five loops that matter during the sitting: `heartbeat-sweep` (30 s), `deadline-sweep` (15 s; seals attempts whose own deadline passed ≈30 s earlier, one transaction each), `seal-closed-exams` (5 s; finishes sealing after the Examination Section closes), `forensics`, and the mail/webhook lanes.
- **Database guard-rails** (migration 0102, role `examos_app`): `lock_timeout 5s`, `statement_timeout 30s`, `idle_in_transaction_session_timeout 60s`; the API's pool acquire times out after `DB_ACQUIRE_TIMEOUT_MS` (10 s). Any of these surfaces as `503 DB_BUSY, retryable:true`; the student client keeps the draft and retries with back-off. Both hash chains carry unique tripwire indexes: a forked chain is a hard error, never a silently "broken" timeline.
- **Redis is never authoritative.** A flush or failover makes the heartbeat sweep open a fresh 90 s grace window for every active attempt instead of moving them all to recovery.
- **Request mix per student** (what to size the proxy and database for): heartbeat every 20 s, save every 3–15 s while typing, system scan every 60 s, token refresh every 10 min. 2,000 students ≈ 280–420 req/s steady state, ≈ 50,000 requests in the first two minutes of admission, ≈ 1,800 row writes/s at the top of the range.
- **PDFs.** Playwright needs a Chromium: `npx playwright install chromium` on the image, or `CHROMIUM_EXECUTABLE_PATH` pointing at a system build. Rendered documents go to `STORAGE_DIR` (local disk) until object storage is wired; with more than one API node use shared storage.
- **Trust proxy.** Production trusts exactly one proxy hop (`trust proxy = 1`); elsewhere only loopback callers may present `X-Forwarded-For`.

## Exam client headers (SPA host)

Serve the web app with at least:

```
Content-Security-Policy: default-src 'self'; connect-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'
Permissions-Policy: camera=(self), microphone=(self), display-capture=(), window-management=(self)
```

`connect-src 'self'` keeps every request from a student's device on the exam origin (the on-device face detector's runtime would otherwise send usage telemetry to Google; the app also refuses it in code). `'wasm-unsafe-eval'` lets the detector run; it is loaded only for exams with the camera presence check on. After every deploy run `SMOKE_BASE_URL=https://<host> SMOKE_HOST=<host> npm run smoke` with the tenant's own staff and student test accounts.

## Coding questions: the judge

Programs run only in a self-hosted Judge0 (https://github.com/judge0/judge0) on its own server: no outbound network, CPU/memory/time limits per run. Set `JUDGE_URL` (and `JUDGE_TOKEN` if the judge requires `X-Auth-Token`) for the API and the worker. Language ids used: C 50, C++ 54, Java 62, Python 3 71 (check your Judge0 version's `/languages`). Load: one run per hidden test per student after the exam, plus limited sample runs during it — size the judge before the first coding exam. Without `JUDGE_URL`, coding answers are marked by examiners only.
