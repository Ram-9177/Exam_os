# Development checklist

Statuses: **Not Started** · **In Progress** · **Tested** (an automated test exercises it against the real database) · **Completed** (tested *and* reviewed/accepted by the university). Nothing is marked Completed yet because no university acceptance has happened. "Tested" names the test file.

## Platform and tenancy
| Feature | Status | Evidence |
| --- | --- | --- |
| Tenant groups, tenants, domains; host-based tenant resolution | Tested | tenancy.test.ts |
| Row-level security on every tenant table, forced, app role without bypass | Tested | tenancy.test.ts (zero rows without context, cross-tenant insert refused) |
| Append-only audit with per-tenant hash chain; evidence tables append-only at privilege + trigger level | Tested | tenancy.test.ts |
| Tenant provisioning (platform bootstrap key) with admin activation mail | Tested | helpers/provisionTenant |
| Platform admin accounts replacing the bootstrap key | Not Started | — |
| Per-tenant rate-limit pools (student saves vs integration) | Tested (limiter) / Not Started (load proof) | auth.test.ts lockout; Gate G load test pending |

## Identity and access
| Feature | Status | Evidence |
| --- | --- | --- |
| Local login, bcrypt, lockout, constant-work failure path | Tested | auth.test.ts |
| RS256 access tokens (10 min), JWKS, no roles in tokens | Tested | auth.test.ts |
| Refresh rotation with reuse detection (family revocation) | Tested | auth.test.ts |
| Permissions re-read from role_grants per request; scoped ABAC (exam/department) | Tested | auth.test.ts, exam-flow (student vs staff routes) |
| Single-use activation links; no passwords in mail | Tested | auth.test.ts |
| OIDC (Microsoft Entra / Google Workspace): discovery, PKCE, nonce, JWKS verification, no JIT provisioning, domain allowlist | Tested | auth.test.ts (fake IdP) |
| MFA for high-impact roles | Not Started | — |

## ERP integration (Simple API)
| Feature | Status | Evidence |
| --- | --- | --- |
| Tenant API keys (SHA-256, scopes, revoke, expiry, IP allowlist) | Tested | integration.test.ts |
| Roster push: academic units (school→dept→programme), courses, persons, enrolments; per-row outcomes; sync jobs | Tested | integration.test.ts |
| Identity by (provider, externalId); e-mail never merges; IDENTITY_CONFLICT | Tested | integration.test.ts |
| Idempotency-Key replay / 409 on body change | Tested | integration.test.ts |
| Integration events + outbox; signed webhooks; backoff; dead-letter; admin replay | Tested | integration.test.ts |
| Cursor event feed | Tested | integration.test.ts |
| Results pull (published only, no proctoring data) | Tested | exam-flow.e2e.test.ts |
| XLSX import (L0) through the same roster service (download templates, preview, identity conflicts, per-row outcomes) | Tested | erp-adapters.test.ts, erp-import.test.tsx |
| Adapters that pull from the ERP (`uos`, `generic-rest` with field mapping, dry-run & live sync) | Tested | erp-adapters.test.ts, erp-import.test.tsx |

## Exam mail
| Feature | Status | Evidence |
| --- | --- | --- |
| Outbox with dedupe, two lanes, SKIP LOCKED claiming, backoff, callback timeout | Tested | mail.test.ts |
| Power Automate transport + callback endpoint (bearer secret) | Tested | mail.test.ts (emulated flow) |
| Graph transport (app permission, scoped mailbox) | In Progress | code present, not exercised against Graph |
| SMTP OAuth2 / relay transports (Nodemailer) | In Progress | code present, not exercised against a server |
| Versioned templates, HTML escaping, per-tenant override | Tested | mail.test.ts |
| Bounce reconciliation from the shared mailbox and NDR webhooks | Tested | erp-adapters.test.ts, erp-import.test.tsx |

## Exam lifecycle and conduct
| Feature | Status | Evidence |
| --- | --- | --- |
| Exam create with type/year/semester/profile (aliases normalised), hierarchy filters | Tested | exam-flow.e2e.test.ts |
| Human-triggered conduct: submit-for-review → approve → schedule → open readiness → start → close; illegal transitions refused | Tested | exam-flow |
| Allocation of eligible students only; locked while PRECHECK/LIVE | Tested | exam-flow |
| Hall tickets per exam, PDF with signed verification QR, visible per exam to the student | Tested | exam-flow, documents.test.ts |
| Export lock during PRECHECK/LIVE with audit + alert mail | Tested | exam-flow |
| Question paper authoring, sections, kinds, rubrics, draft/review/approved lifecycle | Tested | paper.test.ts, paper-tab.test.tsx |
| Question paper encryption at rest (AES-256-GCM), canonical SHA-256 seal, exam approval gate (marks match) | Tested | paper.test.ts |
| Question paper sets generation (Set A/B question shuffling) | Tested | paper.test.ts |
| Student paper release (gate exam LIVE, expected_answer & rubric stripped, paper_releases append-only audit) | Tested | paper.test.ts |
| Candidate paper view & answer booklet question prompts & evaluator marking validation | Tested | paper.test.ts, booklet.test.tsx |
| Question paper ingestion (DOCX/PDF), question bank | Not Started | spec §5, §12 |
| Rooms, benches, seat assignments | Not Started | spec §40, §50 |

## Readiness check and admission
| Feature | Status | Evidence |
| --- | --- | --- |
| Precheck runs/items with sources; server-measured identity/eligibility/consent | Tested | exam-flow, recovery |
| Clock sync, keyboard functional test (no WPM), optional canvas/stylus test, practice save round-trip | Tested | exam-flow |
| Secure client verification via SEB Config Key hash; allowed client builds | Tested | recovery.test.ts, secure-client.test.ts |
| SEB configuration generator (POST /exams/:id/seb-config), kiosk mode XML plist, download authorization, and audit trail | Tested | secure-client.test.ts, docs/seb-rollout.md |
| MANAGED_ENDPOINT lab network subnet attestation and client policy management | Tested | secure-client.test.ts |
| Extended client-side signals (DISALLOWED_APP_DETECTED, VIRTUAL_MACHINE_DETECTED) with human-only warning invariant | Tested | secure-client.test.ts |
| Pre-publication staff booklet download audit (booklet.downloaded) | Tested | secure-client.test.ts |
| Camera/microphone honest UNVERIFIABLE on high tiers | Tested | exam-flow |
| Readiness board for the Examination Section (per check, instruction, blocking, exceptions) | Tested | exam-flow |
| Admission exceptions; security checks waivable only by Controller; expiry | Tested | exam-flow, recovery |
| One-time admission grant consumed atomically; lobby until exam LIVE | Tested | exam-flow (6-way race) |
| Face reference / 1:1 match / PAD / manual referee | Not Started | Gate C |
| Media snapshot verification for camera/mic | Not Started | Gate C |

## Answers and submission
| Feature | Status | Evidence |
| --- | --- | --- |
| Versioned saves, client operation idempotency, revision conflict, content hash verification | Tested | exam-flow |
| Device-session binding; second device = server-observed incident | Tested | exam-flow, recovery |
| Heartbeat, IP-change logging, stale sweep → RECOVERY_PENDING, reconnect | Tested | recovery.test.ts |
| Atomic seal: manifest, receipt, candidate packet, idempotent submit, late writes refused | Tested | exam-flow |
| Server deadline authority at close (expire + seal) | Tested | exam-flow |
| Canvas vector blocks stored and server-side PDF render pipeline | Tested | documents.test.ts, web renders |
| Offline draft recovery UI | In Progress | apps/web |

## Proctoring
| Feature | Status | Evidence |
| --- | --- | --- |
| Signal ingest with dedupe and grouping window; technical classes uncountable | Tested | exam-flow |
| Human decisions; one warning per incident per epoch; idempotent decisions | Tested | exam-flow |
| Fifth-warning atomic suspension under concurrent saves; alert mail | Tested | exam-flow (race) |
| Resume with new epoch, history retained, deadline extension, device re-bind | Tested | exam-flow, recovery |
| Technical hold (no epoch change) | Tested | recovery.test.ts |
| Rolling media buffer, 5-second clips, 5 snapshots, gap detection, evidence viewer | Not Started | Gate C/D |
| AI vision/audio signal producers | Not Started | Gate C/D |

## Post-exam
| Feature | Status | Evidence |
| --- | --- | --- |
| Forensic completeness checks (manifest, ledger, timeline chain, incidents) | Tested | exam-flow |
| Examiner marks with one explanation per question; range/criteria validation | Tested | exam-flow |
| Exam Cell checklist + approval bound to result version; invalidation on new version | Tested | exam-flow |
| Holds and release with student notice and ERP event | Tested | exam-flow |
| Controller authorization + publication; idempotent | Tested | exam-flow |
| Lifelong student ledger; semester and overall rollups | Tested | exam-flow |
| Digital answer booklet JSON + verification endpoint | Tested | exam-flow |
| Booklet PDF rendering (server-side), hall tickets, and restricted evidence PDF with verification QR codes | Tested | documents.test.ts |
| Student document storage (photo, ID card), explicit consent gate, SHA-256 hash, and audit trail | Tested | analytics.test.ts |
| Verifiable student examination ID card with signed QR and safe public verification endpoint | Tested | analytics.test.ts |
| Department academic analytics (pass rate, semester rollups, exam distribution, HOD department scoping, strict proctoring privacy) | Tested | analytics.test.ts |
| Evaluator workload balancing and batch assignment | Tested | evaluation-scale.test.ts, evaluation.test.tsx |
| Anonymized candidate marking for external exams (masks student identity) | Tested | evaluation-scale.test.ts, evaluation.test.tsx |
| Double evaluation with divergence threshold (15%) and moderator resolution | Tested | evaluation-scale.test.ts, evaluation.test.tsx |
| Revaluation lifecycle (student request, window check, exam cell decision, re-marking, ledger supersede, and result.corrected event) | Tested | evaluation-scale.test.ts, evaluation.test.tsx |
| AI rubric-based evaluation proposals | Tested | evaluation-scale.test.ts, evaluation.test.tsx |
| Answer similarity analysis and adjudication (MinHash/shingles, integrity hold) | Tested | evaluation-scale.test.ts |

## Web application (apps/web) — React 19, Vite, Tailwind 4, TanStack Query, React Router 7, custom components
| Feature | Status | Evidence |
| --- | --- | --- |
| Login (password + SSO redirect), activation, OIDC callback, public verify page | Tested | apps/web/test/login.test.tsx; smoke-tested against the live API |
| Student: exam list with one status-driven action, hall ticket drawer (printable), lobby polling, ledger | Tested | smoke-tested; readiness/time reducers unit-tested |
| Student Profile & ID: identity card, photo upload with consent modal, verification QR code, SVG performance progression chart | Tested | apps/web/test/profile.test.tsx |
| Academic Analytics: department dashboard for HOD/Controller, KPI metrics, semester rollups, course distributions, strict privacy assurance | Tested | apps/web/test/analytics.test.tsx |
| 15-minute readiness screen (one step at a time, no WPM, optional drawing, consent, camera preview, verdict stamp) | Tested | apps/web/test/readiness-screen.test.tsx, readiness.test.ts; smoke-tested end to end |
| Exam workspace: server-derived timer, question map, paragraph + canvas editor, autosave with baseRevision/clientOperationId/contentSha256, 409 rebase, draft queue, heartbeat, paused overlay, device-mismatch screen, signal reporting, submit with receipt | Tested | apps/web/test/exam-workspace.test.tsx, sync.test.ts, answers.test.ts, canonical.test.ts; smoke-tested (typed + drew → 200, hash matched server) |
| Digital answer booklet with print layout (A4, page per question) | Tested | apps/web/test/booklet.test.tsx; printed to PDF in smoke test |
| Exam Section: hierarchical exam list, new exam, conduct controls with consequence dialogs, allocations, hall tickets, Readiness Board (10 s), exceptions, Candidates with checklist drawer (approve/hold/release/authorize), export lock message | Tested | apps/web/test/readiness-board.test.tsx; smoke-tested through the full post-exam chain |
| Safe Exam Browser integration: student .seb download on exam cards, Exam Section SEB generator and policy panel | Tested | apps/web/test/secure-client.test.tsx |
| Evaluator marks screen (assigned queue, anonymization, one explanation per question, criteria) | Tested | apps/web/test/evaluation.test.tsx; smoke-tested |
| Proctor console (5 s queue, decisions, technical hold, resume for Chief Proctor, timeline) | In Progress | smoke-tested; no render test yet |
| Tenant admin (users/roles, mail config, mail log, SSO, API keys, webhooks, deliveries replay, audit) | In Progress | smoke-tested; no render test yet |
| Question paper rendering in the workspace | Not Started | placeholder question list (`?questions=` or Q1..Q5) until the paper module exists |

## Operations
| Feature | Status | Evidence |
| --- | --- | --- |
| Worker loops (outbox, webhooks, two mail lanes, forensics, heartbeat sweep) | In Progress | functions tested per pass; long-running loop not load-tested |
| 3,000-session load test, 1,500 preflight burst | Not Started | Gate G |
| Capacity & budget model (`scripts/capacity-model.mjs`, `docs/capacity-and-budget.md`) | Tested (model runs; figures are estimates, not measurements) | 1,000 × 3.5 h → ~125 req/s, ~0.6 GB/sitting, ≈ $16 burst per exam day |
| Exam-day scale runbook script (`infrastructure/azure/scale-exam-day.sh`) | Not Started (template only, never run against a subscription) | docs/capacity-and-budget.md §5 |
| BULK-lane transport for external recipients (ACS Email / SES) with quota tracking | Tested | erp-adapters.test.ts, erp-import.test.tsx |
| Revision archival job (hot → Blob Archive after appeal window) | Not Started | docs/capacity-and-budget.md §1 |
| Backups, PITR drills, observability dashboards | Not Started | Gate G |
| Dependency audit (`npm audit`, prod + dev) | Tested | 0 vulnerabilities after upgrades (docs/security-review.md) |
| Black-box security probes (18 checks) | Tested | `npm run security:probes` |
| Independent penetration test, DAST/SAST in CI, privacy impact assessment | Not Started | docs/security-review.md lists the required scope |
