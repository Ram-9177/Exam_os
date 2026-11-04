# Role-Gap Audit — November 2026

Audit conducted across all roles defined in `packages/contracts/src/enums.ts`.
Findings are classified as **Fixed** (addressed in this session, test file named)
or **Open** (requires a §11 decision, out-of-scope for Phase 1, or deferred to a
later gate).

---

## Roles in scope

| Role | Abbrev | Scope |
|---|---|---|
| STUDENT | S | Own attempts, results, profile |
| EVALUATOR | EV | Assigned answer scripts |
| MODERATOR | MOD | Disputed evaluation samples |
| PROCTOR | PR | Live monitoring during exam |
| CHIEF_PROCTOR | CP | Proctoring oversight + examcell read |
| EXAMINATION_SECTION | ES | Exam lifecycle, roster, results |
| CONTROLLER | CO | Final approval gate, publication |
| HOD | HOD | Department-level analytics |
| SECURITY_AUDITOR | SA | Audit log read-only |
| ADMIN | AD | Tenant-wide user/config management |

---

## Fixed findings (this session)

### AUTH-1 — Query-string token authentication removed
**Role affected:** any  
**Risk:** tokens leaking in proxy logs, Referrer headers, server-side request logs  
**Fix:** `auth.ts` — `?token=` / `?access_token=` paths removed; bearer header only  
**Test:** `role-gaps.test.ts`

### AUTH-2 — Lockout bypass on locked accounts
**Role affected:** STUDENT / any  
**Risk:** consecutive failed attempts while locked could extend lock window incorrectly  
**Fix:** `auth/service.ts` — attempts while locked do not reset the count; expired lock
resets cleanly  
**Test:** `all-personas-e2e.test.ts`

### AUTH-3 — Activate without state check
**Role affected:** any pending user  
**Risk:** `activate` could be called on already-active or disabled users  
**Fix:** `auth/service.ts` — `assertTransition` enforced; refuses unless
PENDING_ACTIVATION or ACTIVE  
**Test:** `all-personas-e2e.test.ts`

### AUTH-4 — No password-reset flow
**Role affected:** all  
**Risk:** no self-service recovery; helpdesk burden; account takeover if no reset path  
**Fix:** `POST /auth/forgot-password`, `POST /auth/reset-password`; single-use
60-min tokens; revokes all sessions on reset; PENDING users get a new activation
link; always 202 (no user enumeration)  
**Test:** `all-personas-e2e.test.ts`

### AUTH-5 — ERP ACTIVE overrides local disabled status
**Role affected:** any  
**Risk:** re-enabling a deliberately disabled staff or student account via ERP sync  
**Fix:** `integration/roster.ts` — ERP ACTIVE no longer overrides LOCAL_DISABLED  
**Test:** `role-gaps.test.ts`

### PAPER-1 — Rubric / expected-answer leakage to non-key-holders
**Role affected:** STUDENT, EVALUATOR (before exam)  
**Risk:** correct answers visible in API response  
**Fix:** `papers/service.ts` — `PaperViewer` model (KEYS / PROMPTS / NONE);
rubric + expectedAnswer stripped for PROMPTS; 403 for NONE  
**Test:** `paper.test.ts`

### PAPER-2 — No audit on pre-LIVE paper reads
**Role affected:** EVALUATOR, HOD, ADMIN  
**Risk:** pre-publication leak not recorded  
**Fix:** `papers/service.ts` — audit row written on any non-DRAFT read before LIVE  
**Test:** `paper.test.ts`

### PAPER-3 — MCQ accepted with 0 or 1 option
**Role affected:** paper author (EXAMINATION_SECTION)  
**Risk:** malformed MCQ passes review; students see broken question  
**Fix:** `papers/service.ts` — `submitPaperForReview` returns 422
MCQ_OPTIONS_REQUIRED when < 2 options  
**Test:** `paper.test.ts`

### EVAL-1 — Any evaluator could mark any attempt
**Role affected:** EVALUATOR  
**Risk:** evaluator could access or submit marks for scripts not assigned to them  
**Fix:** `evaluation/service.ts` — `assertMayMark` returns 403 NOT_ASSIGNED when
assignments exist and none belongs to the caller  
**Test:** `evaluation-scale.test.ts`

### EVAL-2 — No identity blinding for evaluators
**Role affected:** EVALUATOR, MODERATOR  
**Risk:** evaluator sees student name and roll number, compromising blind marking  
**Fix:** `evaluation/service.ts` — `blindingFor` returns hideIdentity,
hidePriorMarks, anonymizedIdentifier; booklet route blinds for
marks:approve callers without examcell:candidates:read  
**Test:** `evaluation-scale.test.ts`

### EVAL-3 — No moderation queue endpoint
**Role affected:** MODERATOR  
**Risk:** moderators had no way to see pending samples  
**Fix:** `GET /evaluator/me/moderation/pending` (evaluation:moderate)  
**Test:** `evaluation-scale.test.ts`

### EVAL-4 — Partial marks accepted as complete result
**Role affected:** EXAMINATION_SECTION / CONTROLLER  
**Risk:** result version published with unanswered questions marked as zero without
explicit decision  
**Fix:** `candidates/service.ts` — `recordResultVersion` returns 422
MARKS_INCOMPLETE when any paper question is unmarked  
**Test:** `paper.test.ts`

### ANALYTICS-1 — Analytics overview visible to all authenticated users
**Role affected:** EVALUATOR, STUDENT, etc.  
**Risk:** cross-department score distributions visible to roles without analytics:read  
**Fix:** `analytics/routes.ts` — `departmentScopeOf(grants, 'analytics:read')`; 403
for NONE; HOD scoped to own department  
**Test:** `analytics.test.ts`, `role-gaps.test.ts`

### ATTEMPT-1 — Answers accepted for non-existent question IDs
**Role affected:** STUDENT  
**Risk:** client could save answers for question IDs not in the approved paper; data
integrity violation; potential injection  
**Fix:** `attempts/service.ts` — `saveAnswer` checks question exists in the latest
approved paper on first write; 422 UNKNOWN_QUESTION_ID  
**Test:** `recovery.test.ts`, `role-gaps.test.ts`

### APPEND-1 — Missing forbid-mutation triggers
**Role affected:** infrastructure  
**Risk:** application bug or direct SQL could mutate append-only tables  
**Fix:** Migration `20261030000104_append_only_gaps.ts` adds
`examos_forbid_mutation` triggers on `submission_manifests`,
`resume_grants`, `controller_publication_grants`  
**Test:** migration (DB-enforced at all times)

### PROFILE-1 — Photo URL contained access token
**Role affected:** STUDENT  
**Risk:** token in URL leaked in Referer / proxy logs; token replay  
**Fix:** `ProfilePage.tsx` / `profile/routes.ts` — photo served as binary blob via
authenticated fetch; no token in URL  
**Test:** `profile.test.tsx`

### PROFILE-2 — Photo audit missing actor on behalf-of writes
**Role affected:** ADMIN, EXAMINATION_SECTION  
**Risk:** audit row recorded wrong actor when staff uploaded a student photo  
**Fix:** `profile/service.ts` — `uploadStudentPhoto(actorId, …)` passed from route  
**Test:** `role-gaps.test.ts`

---

## Open findings (deferred / §11 decisions needed)

| ID | Area | Description | Blocker |
|---|---|---|---|
| SEATS-1 | Multi-tenant | Staff seat cap (3–4 per campus) not enforced | §11 decision: cap per plan tier |
| MALPRACTICE-1 | Proctoring | No malpractice or void route; ESCALATE is a dead end | §11 decision: who may declare malpractice |
| ABSENTEE-1 | Exam day | No absentee recording route | §11 decision: scope |
| EXAM-EDIT-1 | Exam cell | No exam edit / reschedule | Out of scope Phase 1 |
| EVAL-DRAFT-1 | Evaluation | Evaluator cannot save a draft before submitting marks | Out of scope Phase 1 |
| RUBRIC-DISPLAY | Evaluation | Rubric not shown alongside answer for evaluator | Out of scope Phase 1 |
| DOUBLE-EVAL-1 | Evaluation | Raw UPDATE used in double-evaluation path (not append-only) | Needs ADR |
| HOD-RESULTS | Analytics | HOD result visibility: should HOD see individual marks? | §11 decision |
| BULK-APPROVE | Evaluation | No bulk approve / bulk publish | Out of scope Phase 1 |
| RESULT-EXPORT | Results | No result export (CSV/PDF) | Out of scope Phase 1 |
| REVALUATION | Results | Revaluation status not tracked | Out of scope Phase 2 |
| SUPP-RULES | Supplementary | Supplementary exam eligibility rules not coded | §11 decision |
| CRON-1 | Reminders | No reminder/cron jobs for deadlines | Out of scope Phase 1 |
| ATTACH-1 | Documents | No attachment storage for evaluator evidence | Out of scope Phase 1 |
| MFA-1 | Auth | No MFA / TOTP | Out of scope Phase 1 |
| SSRF-1 | Security | No SSRF protection on webhook/integration URLs | Phase 2 |
| CSP-1 | Security | No Content-Security-Policy header | Phase 2 |
| MAIL-DUP | Outbox | Mail deduplication not fully tested under worker restart | Phase 2 |
| AUDIT-FILTER | Audit | Audit log has no filter/pagination endpoint | Phase 2 |
| DEVICE-MISMATCH | Recovery | Device-mismatch recovery UI not implemented | Phase 2 |
| POST-EXAM-STATUS | Student | Student status not updated after results published | Phase 2 |
| TENANT-BOOT | Tenant | First-mail bootstrap for a new tenant | Phase 2 |
| PROCTOR-ROSTER | Proctoring | Proctor roster and manual proctor actions | Phase 2 |

---

## §11 Decision log

The following decisions are needed from the university (from plan §11); none has been
answered yet:

1. **Staff seat cap** — maximum simultaneous staff seats per campus tier
2. **Malpractice authority** — which role may declare malpractice/void
3. **HOD result visibility** — may HODs see individual student marks?
4. **Double-evaluation policy** — when scores diverge, automatic moderate or manual?
5. **Seating** — does the platform manage physical seat assignments?
6. **Supplementary rules** — eligibility criteria and exam cycle for supplementary

---

_Audit conducted 2026-11-04. Next review: before Phase 2 gate._
