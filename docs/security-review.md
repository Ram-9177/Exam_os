# Security review status (30 Oct 2026)

**This is not a penetration test.** It records what has been verified automatically in this repository and what an independent assessment still has to do before any high-stakes exam (spec §19: OWASP ASVS 5.0 baseline plus an independent penetration test before launch).

## Verified automatically

| Area | How | Result |
| --- | --- | --- |
| Dependency vulnerabilities | `npm audit` (production and development trees) | **0 vulnerabilities** after upgrading bcrypt 5→6 (node-tar path traversal in its build chain), nodemailer 6→10 (recipient-domain confusion, SMTP command injection), zod 3→4.6.7 (memory exhaustion on oversized collections), vitest 2→4.1.12 (dev-only path traversal / prototype pollution). All 96 tests re-run green after the upgrades |
| Tenant isolation | `tenancy.test.ts` | valid tenant-A token refused on tenant-B host; RLS returns zero rows without tenant context and refuses cross-tenant inserts; worker bypass only in worker context |
| Append-only evidence | `tenancy.test.ts` | UPDATE/DELETE on audit, answer revisions, warnings and timeline refused for the app role and blocked by trigger even for the superuser |
| Authentication | `auth.test.ts` | lockout after 5 failures, constant-work failure path, single-use activation, refresh rotation with family revocation on reuse, revoked grants effective on the next request, OIDC signature/nonce/state/PKCE, no JIT provisioning |
| Authorization | `exam-flow.e2e.test.ts`, `recovery.test.ts` | students cannot read other attempts (404, not 403), staff routes 403 for students, examiner/Exam Cell/Controller separation, Controller-only security waivers, device-session binding, one-time admission grant under a 6-way race |
| Integrity | `exam-flow.e2e.test.ts` | content hash verification, revision conflicts, fifth-warning atomicity under concurrent writes, approval invalidation on re-marking, export lock with alert |
| Integration surface | `integration.test.ts`, `mail.test.ts` | API key scopes/revocation, idempotency replay/409, HMAC webhook signatures with replay window, callback secret, sealed secrets never returned |
| Black-box probes | `npm run security:probes` against a seeded server | 18/18: no-token 401, unknown host 404, SQL injection in filters/search parameterised, malformed JSON 400, 2 MB body 413, IDOR 404, mass assignment stripped, prototype pollution inert, helmet headers, tampered JWT and `alg=none` 401, API key in query string refused, login brute force 429, error envelope without stack traces |

## Not done — required before a high-stakes exam

1. **Independent penetration test** against a staging deployment (ASVS 5.0 Level 2 scope: authentication, session, access control, input validation, API, business logic for the exam flows, SSRF on webhook URLs, file handling once paper ingestion exists).
2. **DAST scan** (OWASP ZAP or Burp) of the web app and API; **SAST** in CI (CodeQL or Semgrep) — neither is wired yet.
3. **Threat-model walkthrough** with the university's IT security team on the trust boundaries in ADR 0005 and spec §26; decide the certified device/SEB matrix.
4. **Secrets and keys** moved to a KMS/vault (the `vault:` reference scheme is reserved, not implemented); RS256 key rotation runbook.
5. **Rate-limit and capacity testing** at 3,000 sessions (Gate G) — limits exist but their thresholds are untested under load.
6. **Privacy impact assessment** under the DPDP Act before camera/microphone capture goes live (Gate A).
7. **Webhook SSRF hardening**: endpoint URLs are HTTPS-only but not yet checked against private address ranges at delivery time; add an allow/deny list before the integration API is exposed to third-party ERPs.
8. **Content Security Policy** for the served web app (helmet CSP is disabled on the JSON API; the SPA's hosting layer must set it).
