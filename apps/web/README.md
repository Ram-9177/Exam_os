# @examos/web — SMRU ExamOS web application

React 19 + TypeScript, Vite 7, Tailwind CSS 4, TanStack Query 5, React Router 7 (data router), a hand-written accessible component library (no Radix/shadcn/headless UI), Vitest + Testing Library.

## Run

From the repository root:

```sh
npm install                       # workspaces: installs apps/web too
npm run dev -w @examos/web        # http://localhost:5173
npm run typecheck -w @examos/web  # tsc --noEmit
npm run build -w @examos/web      # vite build → apps/web/dist
npm test -w @examos/web           # vitest run
```

### Tenant Host proxy (important)

The API resolves the tenant from the request `Host` header. In development the Vite dev server proxies `/api` and `/healthz` to the API and rewrites the `Host` header to the tenant host, so the browser talks to `localhost:5173` while the API sees the tenant it should serve:

```sh
EXAMOS_TENANT_HOST=demo.examos.local npm run dev -w @examos/web   # default
EXAMOS_TENANT_HOST=localhost npm run dev -w @examos/web           # the seeded demo tenant registers `localhost`
EXAMOS_API_URL=http://127.0.0.1:4000                               # API target (default)
```

In production, serve `dist/` from the tenant's own host (`https://<tenant-host>/`) and reverse-proxy `/api` to the API on the same host; no proxy header rewriting is needed then.

Fonts (Newsreader, Atkinson Hyperlegible Next/Mono) are bundled from npm packages, so the exam workspace never loads anything from an external domain (the lockdown client blocks them).

## Screens and what each one calls

| Route | Role | API calls |
| --- | --- | --- |
| `/login` | public | `GET /tenant`, `POST /auth/login`, `GET /auth/me`; SSO button when `ssoProvider` is set → `GET /auth/oidc/start`, redirect; `/auth/callback` → `POST /auth/oidc/callback` |
| `/activate?token=` | public | `POST /auth/activate` |
| `/verify/:attemptId/:version` | public | `GET /student/verify/:attemptId/:version` |
| `/student` | STUDENT | `GET /student/me/exams`, `GET /student/me/ledger` (to detect published results); lobby polls `POST /student/attempts/:id/entry-grants` every 10 s (409 `EXAM_NOT_STARTED` = keep waiting); Enter exam → entry grant + `POST /student/attempts/:id/admit` (stores `deviceSessionId`); hall-ticket drawer (printable) |
| `/student/ledger` | STUDENT | `GET /student/me/ledger` |
| `/student/attempts/:id/readiness` | STUDENT | `GET /student/attempts/:id/policy`, `POST /student/attempts/:id/prechecks`, `POST /student/prechecks/:runId/items/verify` (CLIENT_VERSION, CLOCK_SYNC, KEYBOARD_INPUT, NETWORK_SAVE_ROUNDTRIP, CANVAS_INPUT, CONSENT, CAMERA, MICROPHONE as the policy lists them), `POST /student/prechecks/:runId/practice-saves` (SHA-256 of the practice text), `POST /student/prechecks/:runId/finalize` |
| `/student/attempts/:id/exam` | STUDENT | `POST /student/attempts/:id/reconnect` (unless freshly admitted), `POST /student/attempts/:id/heartbeat` every 20 s, `GET`/`PUT /student/attempts/:id/answers/:questionId` (autosave: debounce 3 s, max 15 s, `baseRevision`, `clientOperationId`, `contentSha256`; 409 `REVISION_CONFLICT` / 422 → GET + rebase), `POST /proctor/events` (FOCUS_LOST, FULLSCREEN_EXIT, max one per class per 5 s), `POST /student/attempts/:id/submit` (uuid idempotency key, receipt + manifest hash shown) |
| `/student/attempts/:id/booklet` | STUDENT, staff | `GET /student/attempts/:id/booklet`; Download / Print uses `window.print()` with an A4 booklet stylesheet (cover page, a page per question, closing page) |
| `/examcell` | EXAM_CELL_OPERATOR, CONTROLLER | `GET /exams?…` with status/type/year/semester/department/school/search filters, grouped school → department |
| `/examcell/exams/new` | same | `POST /exams` |
| `/examcell/exams/:id` | same | `GET /exams/:id`; conduct: `POST /exams/:id/{submit-for-review,approve,schedule,open-precheck,start,close,archive,cancel}` with confirmation dialogs; `POST /exams/:id/allocations`, `POST /exams/:id/hall-tickets`; **Readiness board** `GET /exams/:id/readiness` every 10 s + `POST /exams/:id/attempts/:attemptId/admission-exceptions` (403 `SECURITY_OVERRIDE_REQUIRED` shown plainly); **Candidates** `GET /exams/:id/candidates`, drawer `GET /candidates/:attemptId/checklist`, `POST …/forensics/run`, `POST …/approvals`, `POST …/holds`, `POST …/holds/release`, `POST …/authorize-publication` (CONTROLLER); **Exports** `GET /exams/:id/exports/scripts` (403 `EXPORT_LOCKED` shown while PRECHECK/LIVE) |
| `/evaluate`, `/evaluate/:attemptId` | EVALUATOR, MODERATOR (+ Exam Cell/Controller) | `GET /exams`, `GET /student/attempts/:id/booklet` (staff view), `POST /candidates/:attemptId/result-versions` |
| `/proctor` | PROCTOR, CHIEF_PROCTOR | `GET /proctor/incidents?…` every 5 s, `GET /exams/:id` (warning threshold), `POST /proctor/incidents/:id/decision`, `POST /proctor/attempts/:id/technical-holds`, `POST /proctor/attempts/:id/resume` (CHIEF_PROCTOR only), `GET /proctor/attempts/:id/timeline` |
| `/admin` | TENANT_ADMIN, SYSTEM_ADMIN, INTEGRATION_ADMIN, SECURITY_AUDITOR, CONTROLLER (tabs follow permissions) | `GET/POST /tenant/users`, `POST/DELETE /tenant/users/:id/roles`, `PUT /tenant/mail-config`, `GET /tenant/mail-dispatches`, `PUT /tenant/sso-config`, `POST/DELETE /tenant/api-keys`, `POST/DELETE /tenant/webhooks`, `GET /tenant/webhooks/deliveries`, `POST …/deliveries/:id/replay`, `GET /tenant/audit` |

## Wired vs placeholder

Everything above is wired to the API with no fake data. The **only placeholder** is the question list in the exam workspace and the marking sheet: the API has no question-paper module yet, so the workspace reads question ids from `?questions=Q1,Q2,…` and otherwise uses `Q1..Q5`, labelled "Question 1" etc. (`useQuestionList` in `src/features/exam/ExamWorkspace.tsx` and `withPlaceholderQuestions` in `src/features/evaluate/EvaluatePage.tsx` are the integration points). Answers are keyed by question id only, so the paper module can replace the list without touching the sync engine.

## Known gaps (API-side, surfaced honestly in the UI)

- `POST /candidates/:attemptId/authorize-publication` needs a `candidateApprovalId`; the checklist now returns `liveApproval`, so the Controller's publish action uses the current approval automatically (the paste field remains as a fallback when no live approval exists).
- The student exam list has no register number, so the hall-ticket drawer shows name, e-mail, hall ticket number, exam and verification hash (the booklet, which has it, shows the register number).
- `GET /tenant/api-keys` and `GET /tenant/webhooks` do not exist; the admin screen lists only keys/endpoints created in the current session.
- `POST/DELETE /tenant/users/:id/roles` work, but current grants are not listed by the API.
- Evaluators cannot list candidates (`examcell:candidates:read`), so `/evaluate` takes an attempt id; the Exam Cell can open a candidate's answers for them from the candidates drawer.
- Camera/microphone checks on high-tier profiles return `UNVERIFIABLE` by design (no media pipeline yet); the UI says "Will be checked by the invigilator".

## Design notes

"The calm examination hall": ledger paper and blue-black ink, one accent (wet ink) reserved for the primary action and the live timer, status colours only for status and never alone (text/icon always present). Newsreader (serif) for headings, Atkinson Hyperlegible Next for text, Atkinson Hyperlegible Mono for identifiers, hashes and the clock. The two loud elements are the rubber stamp (final verdicts: Ready / Fix / Need support / Submitted / Paused / Verified) and the ruled answer sheet with its rose margin line, which is also how the booklet prints. Dark mode follows `prefers-color-scheme`; reduced motion is respected; every control is keyboard-operable with visible focus; dialogs trap and restore focus; the timer is announced every minute and at 5 and 1 minutes.

## Tests

`npm test -w @examos/web` runs 10 files / 48 tests: canonical JSON + SHA-256 (checked against Node's crypto and the API's reference implementation), the autosave op builder, remaining-time from the server clock offset, the readiness reducer, the sync engine (debounce, baseRevision, 409 rebase, idempotent retry, recovery, pause/resume, draft restore), the signal rate limiter, and render tests (StrictMode) for Login (including refresh-on-401), the readiness screen, the Readiness Board, the booklet print layout and the exam workspace (typing → PUT with `baseRevision` 0 → 409 → rebase to revision 3).
