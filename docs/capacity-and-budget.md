# Capacity & budget — sizing for peaks, paying for averages

**Question this answers.** 1,000 students sit the same exam at the same time for ~3.5 hours, several times a term, yet each student only accumulates ~20 exam-hours a year. How much infrastructure does that need, what does it cost, and how do we plan it early without buying 1,000-student capacity for 365 days?

**Short answer.** The platform's own traffic is small: ~125 requests/s and ~200 row-writes/s at 1,000 concurrent students, ~0.6 GB of database growth per sitting and under 2 Mbps of bandwidth without video. On Azure Central India list prices that is **≈ $16 of burst compute per 1,000-student exam day** (≈ 1.6 cents per student per sitting, ≈ $0.004 per student-hour) on top of an always-on baseline of **≈ $190/month**. A 10,000-student university running 20 exam-hours per student per year lands at **≈ $3,400/year (≈ ₹2.9 lakh) for cloud + licences**, i.e. about **$0.34 per enrolled student per year** — provided capacity is scaled up for exam days and back down afterwards, never reserved. The budget drivers are elsewhere: human proctors and evaluators, the optional video tier, and the one-off load test and penetration test.

Everything below is an **estimate from the request mix the shipped client generates**; nothing is measured yet. The Gate G load test (1,500 and 3,000 virtual students) is what converts these into measured numbers before money is committed. Regenerate any figure with `node scripts/capacity-model.mjs --students=… --hours=… --media=…`.

---

## 1. Workload model (what 1,000 students actually generate)

Sources: `apps/web/src/lib/sync.ts` (saves debounced 3 s, max wait 15 s, only on change), `apps/web/src/features/exam/session.ts` (heartbeat every 20 s), `apps/api/src/modules/attempts/service.ts` (one save = insert `answer_revisions` + update `answer_documents`).

| Phase | What happens | Rate at 1,000 students | At 3,000 |
|---|---|---|---|
| Readiness window (15 min; policy allows opening up to 2 h early) | login + ~10 check items per student | ~12 req/s, bcrypt ≈ 0.3 CPU-s/s (OIDC logins cost ~0) | ~37 req/s |
| Admission (Exam Section presses *Start*) | grant consumed, attempt + epoch created, paper fetched | ~8 admits/s for 2 min; **20 Mbps** paper download burst | ~25/s; 60 Mbps |
| Writing (3.5 h) | answer saves (≤ 1 per 15 s while typing), heartbeats (1 per 20 s), proctor signals (~0.5/min) | **105 req/s realistic, 125 worst case** → ~200 row-writes/s, 0.3 MB/s WAL | 315 / 375 req/s → ~590 writes/s |
| Submit (last 5 min) | submit + seal (manifest, candidate packet, forensics, outbox rows) | ~3 heavier transactions/s | ~10/s |
| After the sitting | forensics, evaluator queue, approvals, publish, mails, ERP events | background, minutes to hours, not latency-sensitive | — |

Latency target during writing: p95 < 300 ms for save/heartbeat (the client tolerates far more — saves retry every 5 s and the attempt only enters `RECOVERY_PENDING` after 90 s without a heartbeat).

### Data growth

| Item | Per 1,000-student sitting | Per student-year (20 h) | 10,000 students, 10 years |
|---|---|---|---|
| `answer_revisions` (ops deltas, append-only) | ~0.4 GB | ~2.3 MB | ~230 GB |
| event log + proctor events | ~0.1 GB | ~0.6 MB | ~60 GB |
| final documents, manifests, marks, ledger, mail/integration rows | ~0.07 GB | ~0.4 MB | ~40 GB |
| **Total (no media)** | **~0.6 GB** | **~3.3 MB** | **~330 GB** |
| WAL / PITR backup churn (transient) | ~3.7 GB | — | — |

"Lifelong" is cheap when scoped correctly: the **final answer document, submission manifest, marks, explanations, result versions and ledger** (≈ 50–100 KB per student per exam) stay in PostgreSQL forever; **revisions and raw proctor events** are kept hot for the appeal window (suggest one academic year) and then moved to Blob Archive (≈ $0.002/GB-month), with their hashes staying in the manifest so a booklet can still be verified.

### Media tiers (Gate C — not built; decide before budgeting)

| Tier | What is captured | Ingest at 1,000 students | Storage per sitting | Hot storage cost per sitting |
|---|---|---|---|---|
| 0 — signals only (**today**) | focus/fullscreen/process/clock/network signals, device-session binding, SEB config key | 0 | 0 | $0 |
| 1 — snapshot evidence | webcam/screen JPEG every 60 s + on every incident (~50 KB) | ~7 Mbps aggregate | ~11 GB | ~$0.22/month, then archive |
| 2 — continuous video | 0.5 Mbps per student | **500 Mbps aggregate** | **~790 GB** | ~$16/month per sitting; ~47 TB/year at 60 sittings (≈ $2,700/year hot-then-archive) |

Tier 2 is 1,000× the data of everything else and its first casualty is the **campus uplink and Wi-Fi**, not the cloud. If continuous video is ever mandated for external exams, record locally in the hall (LAN) and upload after the exam rather than streaming live.

---

## 2. Sizing (exam day vs. the rest of the year)

| Component | Always on (≈ 300 days) | Exam day, 1,000 concurrent | Exam day, 3,000 concurrent |
|---|---|---|---|
| API + worker (Node) | 1 × 2 vCPU / 8 GB | **2 × 4 vCPU / 16 GB** added behind the load balancer (HA + ~5× headroom) | 3 × 4 vCPU |
| PostgreSQL 16 (Flexible Server) | Burstable B2ms-class, 128 GB premium SSD, PITR 7–35 days | **General Purpose D4ds_v5** (4 vCPU / 16 GB, 3,000 IOPS included) | D8ds_v5 |
| Connection pooling | PgBouncer (built-in on Flexible Server), 20 connections per API node | 40 pooled connections | 60 |
| Redis 7 | 1 GB (sessions, limiter pools, grants, idempotency) — self-hosted on the API node or Basic C0 | same | same |
| Object storage | Blob Hot for booklets/exports/evidence, Archive after the appeal window | same | same |
| Load balancer / TLS | one Standard LB or a reverse proxy VM with Let's Encrypt | same | same |
| Mail / webhook workers | run inside the API process (outbox + `FOR UPDATE SKIP LOCKED`) | same; 1 extra worker process if Tier 1 media | same |

Why so small: every request is one short transaction on indexed rows; there is no polling of large result sets, no server-side rendering, no video. The numbers that would break this are media (Tier 2) or a client bug that saves every keystroke — the 3 s debounce / 15 s max-wait in `AnswerSync` is a budget control, not just UX.

---

## 3. Cost model (USD, Azure Central India list prices, Oct 2026 — estimates)

Prices used: D4as_v5 $0.111/h; D2as_v5-class $0.06/h; PostgreSQL Flexible GP D4ds_v5 ≈ $366/month ($0.50/h); Burstable B2ms-class ≈ $0.10/h; premium SSD $0.115/GB-month; Blob Hot $0.02 and Archive $0.002/GB-month; egress $0.10/GB; Azure Cache Basic C0 $16/month; monitoring $20/month; load balancer $20/month; Power Automate Premium $15/user/month. Education agreements, Azure sponsorship credits and reserved pricing for the *baseline* can lower these; verify in the Azure pricing calculator.

### Per 1,000-student exam day (24 h of burst capacity)

| Line | Cost |
|---|---|
| 2 burst API nodes × 24 h | $5.33 |
| PostgreSQL scaled B2ms → D4ds_v5 for 24 h | $9.60 |
| Egress (paper, assets, receipts) | $0.26 |
| WAL/backup churn, storage growth | ~$0.36 |
| **Total** | **≈ $15.55 → $0.016 per student per sitting, $0.0044 per student-hour** |

3,000 students × 3 h: ≈ $31 per exam day (3 nodes + D8ds_v5) → $0.010 per student per sitting.

### Per year — 10,000 enrolled students, 20 exam-hours each (≈ 58 sittings of 1,000 × 3.5 h)

| Line | Per year |
|---|---|
| Baseline (always on: node, B2ms, Redis, LB, monitoring, 128 GB) | $2,250 |
| Burst compute, 58 exam days | $900 |
| Power Automate Premium for the flow-owner service account (1 tenant) | $180 |
| Storage growth (33 GB/year hot for ~6 months, then archive) | $25 |
| **Total, Tier 0** | **≈ $3,350 (≈ ₹2.9 lakh) → $0.34 per enrolled student per year** |
| Tier 1 snapshots | + ~$200 |
| Tier 2 video | + ~$4,100 (storage) + ingest nodes + campus uplink upgrade |

Per additional campus (tenant): + $180/year licence, + its own free shared mailbox; compute is shared. Two campuses examining simultaneously simply add their concurrency (2 × 1,000 ≈ the 3,000 row above). Past ~5,000 concurrent, move the largest tenant to its own database — the RLS design keeps the application unchanged.

### What the cloud figure does **not** include (the real budget)

| Item | Sizing note | Order of magnitude |
|---|---|---|
| Proctor reviewers on the console | Tier 0: ~1 per 100 students; Tier 1/2: ~1 per 30–40. For 1,000 students: 10 vs. 25–35 staff × 4 h | the largest recurring cost until Gate C/E triage exists |
| Exam Section during readiness | expect 5–10 % of students (50–100) to need remediation. Open PRECHECK 60–120 min early (policy allows ≤ 2 h; students re-run the 30-second check inside the 45-min `ready_until`) and station 4–6 helpers | staff time, not servers |
| Evaluators | 1,000 scripts × 10–15 min ≈ 170–250 evaluator-hours per exam; one explanation per question adds ~1–2 min per script | same as paper; AI-assisted grading (Gate E) is not built |
| Load test (Gate G) | k6 at 1,500 and 3,000 virtual students with the real save/heartbeat/signal mix | ~$50–100 cloud spend + 2–3 engineering days |
| Independent penetration test, DPIA/legal review | web + API + tenancy; get three quotes | one-off, budget placeholder |
| DR drill, backups to a second region | restore from PITR into a fresh server; measure RTO | half a day per term; GRS backup ≈ 2× backup storage |
| Student devices | BYOD + Safe Exam Browser (free, open source) or university labs for `MANAGED_ENDPOINT` | $0 licence |
| Campus network | 1,000 seats need ~25–35 access points (30–40 clients each) and a DHCP pool to match; bandwidth is trivial without video (**< 2 Mbps steady, 20 Mbps at admission**), 500 Mbps upstream with Tier 2 | capital item owned by the campus |

---

## 4. Quotas that bind before the servers do

| Quota | Value | Consequence for a 1,000-student sitting | Mitigation (already designed) |
|---|---|---|---|
| Exchange Online message rate, per mailbox | 30 messages/minute (excess is queued) | a 1,000-mail wave takes ~33 min | BULK lane is throttled and never time-critical: hall tickets T-3 days, admission/submission receipts drain in the background, results later. TRANSACTIONAL lane (alerts, suspensions) stays small |
| Exchange Online recipient rate, per mailbox | 10,000 recipients / 24 h | 4 mails per student → 4,000/sitting; two sittings per mailbox per day is the ceiling | one shared mailbox per tenant; spread hall tickets and results to other days |
| Exchange Online **external** recipient rate | 2,000 / 24 h per mailbox | binds if students' mailboxes are *outside* the M365 tenant (Google Workspace campuses, personal Gmail) | route the BULK lane to Azure Communication Services Email / SES (~$0.00025 per mail → **≈ $1 per sitting**) via an additional transport; keep exam@ as the visible sender/reply-to |
| Power Automate Premium (flow owner) | 40,000 Power Platform requests / 24 h per licensed user | ~3–4 actions per mail run → ~10,000 mails/day/owner | matches the Exchange cap; add a second licensed owner for a second tenant |
| Power Automate HTTP trigger | premium connector | the flow-owner service account must hold Power Automate Premium ($15/month) | one per tenant; the Process (per-flow) plan at $150/month is not needed |
| Admission grant TTL, `ready_until` 45 min | product policy | students who ran readiness early must re-run it in the last 45 min | the check takes ~30 s; open PRECHECK early for remediation, re-validate late |

---

## 5. Paying only for peaks — the runbook ("how to do this early")

1. **Keep the baseline tiny all year.** One 2-vCPU node, Burstable PostgreSQL, 1 GB Redis. ≈ $190/month. Do **not** buy reserved capacity for exam-day sizes: reserved instances bill 8,760 hours for something used ~1,400 hours a year; on-demand burst is 5–10× cheaper here. Reserve only the baseline if a 1-year commitment is acceptable.
2. **T-1 day, scale up** (`infrastructure/azure/scale-exam-day.sh up`): PostgreSQL B2ms → D4ds_v5 (one restart, 1–2 min — do it the evening before, never inside a window), add 2 API nodes to the backend pool, confirm PgBouncer pool size, warm JWKS/mail templates, run `npm run security:probes` and a 100-user k6 dress rehearsal against production, send one test mail through the Power Automate flow, check the ERP webhook endpoint health and the mailbox's remaining daily quota.
3. **Exam day:** Exam Cell opens PRECHECK 60–120 min early; readiness board + helpers in the hall; Exam Cell starts the exam; proctor console staffed per §3.
4. **T+1 day, scale down** (`scale-exam-day.sh down`) once forensics and seal jobs have drained; archive revisions older than the appeal window monthly.
5. **Measure before committing money:** run Gate G at 1,500 and 3,000 virtual students; adopt the node counts the measured p95 supports, not the estimates above. Re-run the model with the measured per-request cost: `node scripts/capacity-model.mjs --students=3000 --hours=3`.
6. **Watch the quotas in §4** — they, the campus Wi-Fi and the humans are what fail first, not the API.

## 6. Status

### Measured on 2026-10-30 (single box, not the exam-day tier)

`apps/api/scripts/load-smoke.ts` on one 4-vCPU / 15 GB machine running PostgreSQL 16, Redis 7, one API process (pool 20) **and** the load generator. Real routes for activation, readiness and admission; then per student a heartbeat every 20 s, a save every ~4 s and a system scan every 60 s.

| Students × duration | req/s | save p50 / p95 / p99 | heartbeat p99 | admission burst | errors | chain forks |
| --- | --- | --- | --- | --- | --- | --- |
| 300 × 90 s (code before the audit fixes) | 107.5 | 24 / 43 / 56 ms | 46 ms | 300 in 3.3 s | 0 | **1 timeline, 124 audit** |
| 300 × 90 s (after) | 107.7 | 24 / 44 / 64 ms | 49 ms | 300 in 4.0 s | 0 | 0 |
| 600 × 120 s (after) | 201.6 | 54 / 2,214 / 2,543 ms (one process, pool 20 queueing) | 2,553 ms | 600 in 8.0 s, p99 1.16 s | 0 | 0 |

Reading it: the request path is cheap (≈10 SQL round trips per save, ≈7 per heartbeat, 2 transactions per request). At 300 students the box idled (≤ 6 active backends); at 600 a single API process with a pool of 20 became the queue (21 active backends, p95 2.2 s, still zero errors) — so plan **≈200 req/s per API process at p50 ≈50 ms**, i.e. four processes for 2,000 students, behind PgBouncer. PostgreSQL itself was not the limit in either run. What the earlier model missed was not throughput but write amplification and correctness under concurrency (fixed; see the audit). The sizing table above still stands; the Gate G test on the real tier remains the acceptance criterion.

| Item | State |
|---|---|
| Capacity model (`scripts/capacity-model.mjs`) | Tested (runs; figures are estimates from the request mix, not measurements) |
| Azure scale runbook script (`infrastructure/azure/scale-exam-day.sh`) | Not Started as a tested artefact — template only, never executed against a subscription |
| Gate G load test (1,500 / 3,000 virtual students) | Not Started |
| ACS Email / SES transport for the BULK lane | Not Started (transports: power-automate, smtp-oauth2, smtp-relay, graph, capture exist) |
| Revision archival job (hot → Blob Archive after the appeal window) | Not Started |
