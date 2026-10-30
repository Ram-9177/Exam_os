---
description: Security and integrity invariants for SMRU ExamOS — always apply when touching apps/api, packages/db or packages/contracts
trigger: always_on
---

# ExamOS security and integrity invariants

- Tenant isolation is enforced by PostgreSQL row-level security on `app.tenant_id`; every query runs inside `withTenantTx`. A query that returns zero rows outside a tenant transaction is a bug, not an empty result — tests assert counts.
- The application database role `examos_app` has no superuser/BYPASSRLS and only INSERT on evidence tables. Migrations run as the admin role.
- Access tokens are RS256, 10 minutes, carry no roles; permissions come from `role_grants` on every request. Refresh tokens rotate; reuse revokes the family.
- Readiness checks: only `IDENTITY_SESSION`, `ELIGIBILITY`, `CLIENT_VERSION`, `NETWORK_SAVE_ROUNDTRIP`, `CLOCK_SYNC`, `CONSENT` are server-measurable. `CAMERA`/`MICROPHONE` are `UNVERIFIABLE` until the media pipeline verifies a server-received capture. `CANVAS_INPUT` is optional.
- Security-required checks (`IDENTITY_SESSION`, `ELIGIBILITY`, `CLIENT_VERSION`, `CONSENT`) can be waived only with `preflight:override-security` (Controller).
- Admission grants are one-time (`UPDATE … WHERE consumed_at IS NULL RETURNING`); admission needs the exam to be LIVE.
- Answer saves: lock the attempt with `FOR NO KEY UPDATE`, verify `baseRevision`, apply ops, verify `contentSha256` over canonical JSON of `{blocks:[{id,kind,content}]}`, insert the revision (append-only), update the document; duplicate `clientOperationId` returns the original receipt.
- A request from a different device session records `CONCURRENT_SESSION` in its own committed transaction, then refuses with `DEVICE_SESSION_MISMATCH`.
- Suspension: the Nth confirmed warning in an epoch suspends inside the same transaction as the warning insert; `authorization_generation` increments; resume opens a new epoch only for `WARNING_THRESHOLD`.
- Sealed attempts (`SUBMITTED`, `EXPIRED`, `VOIDED_BY_AUTHORITY`) never accept writes; the manifest lists every question's final revision and hash.
- Publication requires a live Exam Cell approval bound to the current result version; a new result version invalidates approvals. Ledger corrections supersede, never overwrite.
- Script exports during PRECHECK/LIVE write an audit row and a `SECURITY_ALERT` mail first, then refuse with `EXPORT_LOCKED`.
- Integration: API keys are stored SHA-256 with scopes/expiry/IP allowlist; webhooks are signed `t=<unix>,v1=HMAC-SHA256(secret, t.body)`; results pull returns published results only and never proctoring data; endpoint URLs must be HTTPS and (to do) must not resolve to private ranges.
- Never log or return secrets, tokens, or paper content before the exam is LIVE.
