# ADR 0004 — One vocabulary for exam, attempt and candidate states

**Status:** accepted (2026-10-30)

**Context.** Spec v3 described attempts with three different state sets (§6, §26, §46), security profiles with three vocabularies, and exam-level publication states that conflict with per-candidate publication.

**Decision.** `packages/contracts` is the single source: `EXAM_STATUSES` (publication removed from the exam), `ATTEMPT_STATUSES` (Part II set, with `suspension_kind` instead of parallel hold states), `CANDIDATE_STATUSES` (Part IV set, unchanged), `SECURITY_PROFILES` (`PRACTICE, BASIC_BROWSER, SECURE_BYOD, MANAGED_ENDPOINT`, with aliases accepted on input). Transition tables are data (`state-machines.ts`); services refuse any transition not listed; the same values are CHECK constraints in the migrations. The seal boundary (`SUBMITTED`/`EXPIRED`/`VOIDED_BY_AUTHORITY`) creates the candidate packet in the same transaction.

**Consequences.** The API, the database and the UI cannot drift. Illegal transitions surface as `409 ILLEGAL_TRANSITION`.
