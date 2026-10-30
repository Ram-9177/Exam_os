# ADR 0005 — Nothing client-reported is authoritative

**Status:** accepted (2026-10-30)

**Decision.** Readiness checks are recorded with their *source* (`SERVER`, `SECURE_CLIENT`, `PRACTICE`, `CLIENT_DECLARED`, `HUMAN`); the server computes the status. Identity and eligibility cannot be submitted by the client. The secure client is verified by the Safe Exam Browser Config Key hash (SHA-256 of request URL + key), never by a user-agent string. Camera/microphone are `UNVERIFIABLE` on high-tier profiles until the media pipeline exists — an honest status the Examination Section can cover with a named exception; security-relevant checks need a Controller. Admission consumes a one-time grant inside the attempt row lock. Answer saves check the attempt state inside the same transaction that locks the row; Redis holds presence only. A second device is detected by the server (device-session binding), recorded as evidence in its own transaction, and refused. Raw signals never count; `proctor_warnings` rows are created only by a decision row (human, or the server-verified `CONCURRENT_SESSION` class, still through a human decision in this release) and are unique per incident per epoch.

**Consequences.** Every "fatal design mistake" in Part III of the spec has a test that would fail if it were reintroduced (`exam-flow.e2e.test.ts`, `recovery.test.ts`).
