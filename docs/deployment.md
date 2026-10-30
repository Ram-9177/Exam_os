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
- Tenant secrets (flow URL, flow token, callback secret, SSO client secret) are sealed through the admin API and stored as `enc:` references; `env:NAME` references are also accepted for deployment-managed secrets; `vault:` is reserved for the KMS adapter.

## Browser session model
Access tokens (10 min, RS256) are held in memory/sessionStorage by the SPA and sent as a bearer header; refresh tokens rotate with reuse detection. This was chosen over HttpOnly cookies because the exam client (Safe Exam Browser) and the ERP integration share the API, and because a cookie model would need CSRF defences on every mutation. Mitigations: strict CSP on the SPA, no `localStorage`, short token life, family revocation.

## Safe Exam Browser
For `SECURE_BYOD` exams set the exam policy `sebConfigKey` to the Config Key of the `.seb` file issued to students; the readiness check verifies `X-SafeExamBrowser-ConfigKeyHash` = SHA-256(absolute request URL + Config Key). The `.seb` file must allow only the tenant hostname. Generating and signing `.seb` files from ExamOS is a backlog item; until then IT issues them from the SEB config tool and pastes the key into the exam policy.
