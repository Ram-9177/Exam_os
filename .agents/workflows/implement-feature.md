---
description: Implement one feature or phase item from docs/ANTIGRAVITY_CONTINUATION_PLAN.md §8 using the ExamOS change recipe
---

1. Read the phase item in `docs/ANTIGRAVITY_CONTINUATION_PLAN.md` §8 and the related flow in §6. List the tables, contracts, routes, screens and tests it needs before writing code.
2. Contracts: add enums/transitions to `packages/contracts/src/enums.ts` / `state-machines.ts` and Zod schemas to `api.ts` or `integration.ts`.
3. Migration: new file in `packages/db/migrations/` with `tenant_id` on every table; add tables to `TENANT_TABLES` (and `APPEND_ONLY_TABLES` for evidence) in `packages/db/src/index.ts`; enable and force RLS and grant the app role in the migration.
4. Service: `apps/api/src/modules/<module>/service.ts` — functions take `(deps, trx, tenantId, …)`; `assertTransition` before status changes; `forNoKeyUpdate()` locks; record-then-refuse in separate transactions; outbox rows for mails/events in the same transaction.
5. Routes: `requireUser` + `requirePermission`, idempotency middleware on mutating staff actions, `AppError` codes; register in `apps/api/src/app.ts`; document in `docs/api/route-map.md`.
6. Tests: `apps/api/test/<area>.test.ts` against the real database — happy path, refused path, race where concurrency matters. Run `npm test`.
7. Web: `apps/web/src/features/<area>` with components from `apps/web/src/ui`; render test in `apps/web/test`. Run `npm test -w @examos/web` and `npm run typecheck`.
8. Docs: update `docs/DEVELOPMENT_CHECKLIST.md` (status + evidence file), ADR if a decision changed, extend `apps/api/scripts/demo-seed.ts` so the demo walkthrough still covers the feature.
9. Run `/verify`. Report: what was built, test counts before/after, checklist rows changed, open questions (only §11 decisions).
