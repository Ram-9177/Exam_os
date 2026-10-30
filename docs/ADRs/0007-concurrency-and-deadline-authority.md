# ADR 0007 — Concurrency invariants and deadline authority at 2,000 seats

Status: Accepted · Date: 2026-10-30

## Context

A 300-student, 90-second run of the real request mix against the previous code (`apps/api/scripts/load-smoke.ts`) finished with p99 < 60 ms and no errors — and with the attempt timeline chain forked once and the tenant audit chain forked 124 times. Neither is visible to a student; both are visible to the forensic walk, which would have reported "hash chain broken" against innocent candidates. The same review found that closing an exam sealed every open attempt inside one transaction, that nothing sealed a student whose own deadline had passed, that a Redis flush would move every writing student to recovery, and that the client could pause its own autosave forever after one refused write.

## Decisions

1. **Chains are appended under a lock, and forks are impossible by construction.** `audit()` and `logAttemptEvent()` take a transaction-scoped PostgreSQL advisory lock per chain (`lib/locks.ts`) before reading the tail. Migration 0102 adds unique tripwire indexes on `(attempt_id, prev_hash)` and `(tenant, prev_hash)`: if anything ever appends to the same tail twice it is a `409 CONFLICT`, never a silently forked chain. A database that already holds forked history refuses the index and warns — that history is examined, not hidden.
2. **One lock order.** Advisory `ATTEMPT_INCIDENTS` (incident grouping) before `ATTEMPT_TIMELINE_CHAIN` before `TENANT_AUDIT_CHAIN`; attempt row before incident row. Ingest never takes the attempt row because it also runs inside record-then-refuse transactions while the refused request holds that row. A 20-request burst on one attempt (heartbeats from three addresses, six blocking scans, five saves) is the regression test.
3. **The deadline is enforced by the server, per attempt, in small transactions.** Closing an exam sets every open attempt's `deadline_at` to now in one statement (late writes are refused immediately) and seals attempts one transaction each — inline within a budget, then in the worker. A `deadline-sweep` loop seals attempts whose own deadline passed ≈30 s earlier while the exam is still LIVE for students with extra time, re-checking the deadline under the row lock so a proctor's extension is honoured. The heartbeat carries the seal receipt, so a student who ran out of time still receives one.
4. **Redis is advisory.** When the heartbeat sweep finds no key for an active attempt it seeds one (a fresh grace window) instead of treating the attempt as silent; admission and reconnect seed the window themselves.
5. **The database fails fast and honestly.** `DB_POOL_MAX` is real, pool acquire times out in 10 s, and the app role carries `lock_timeout 5s / statement_timeout 30s / idle_in_transaction_session_timeout 60s`. All of these map to `503 DB_BUSY, retryable:true`; nothing on the student path returns a 500 for contention.
6. **Nothing stored is unvalidated.** Every upserted answer block is checked against the schema of its kind before it is applied, hashed or stored; documents are bounded (200 blocks, 4 MB). Refusals are 422 and the client keeps the draft without resending it until the student edits.
7. **Session renewal tolerates a lost response once.** Presenting the just-rotated refresh token inside 30 s revokes the child issued moments ago and issues a fresh pair; a second retry, or any presentation after the window, revokes the family. The client ends its session only on 401/403 from the refresh endpoint; every other failure is transient and retried.
8. **The client follows the server, not its own memory.** Autosave resumes on every heartbeat that reports ACTIVE; requests time out after 15 s; retries back off with jitter; the editor unlocks when a deadline moves later; Submit stays available after local expiry because the server decides.

## Consequences

- Appends to one tenant's audit chain are serialised (≈ one short transaction at a time per tenant). Student-path transactions that audit (admission, login) are short; measured at 300 concurrent admissions the queueing is invisible. If a tenant ever needs more than ~500 audited writes per second the chain must be sharded per actor — not expected.
- Closing a 2,000-seat exam returns in seconds with `sealing.pending > 0`; the Examination Section sees the count fall to zero on the candidates board within a minute.
- The tripwire indexes make the chains part of the schema contract: any new writer must go through `audit()` / `logAttemptEvent()`.
