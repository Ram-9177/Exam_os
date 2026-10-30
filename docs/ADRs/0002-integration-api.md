# ADR 0002 — ERP-agnostic Simple Integration API

**Status:** accepted (2026-10-30)

**Context.** The spec hard-coupled identity to UOS (`external_uos_id`). The group needs any ERP (UOS, Super CXO, SAP, Ellucian, vendor college ERPs) to integrate within a day.

**Decision.** ExamOS owns examination data; the ERP owns identity and enrolment. Identity key: `external_identities(tenant_id, provider, external_id)`; e-mail is an attribute and never merges people (`IDENTITY_CONFLICT`). Four integration levels: XLSX import, push API (`PUT /integration/v1/roster/*/batch`, canonical Zod schemas, `Idempotency-Key`, per-row outcomes, sync job audit), events (signed webhooks `t=…,v1=HMAC-SHA256`, exponential retry, dead-letter + replay, plus a cursor feed), and adapters that pull from the ERP (first adapters: `uos`, `generic-rest` — backlog). Only PUBLISHED results leave ExamOS, never proctoring evidence. API keys are tenant-scoped, SHA-256-hashed, scoped, rotatable (two live keys per connection), optional IP allowlist, separate rate-limit pool from student traffic.

**Consequences.** The ERP never writes into ExamOS tables and ExamOS never writes into the ERP. Every path (XLSX, push, adapter) commits through the same roster service so audits are identical. Proved by `integration.test.ts` and the e2e flow.
