---
description: Full verification pass for SMRU ExamOS — typecheck, API and web tests, dependency audit, black-box probes
---

1. `npm run typecheck`
2. `npm test` (API; requires PostgreSQL 16 + Redis 7 running; `examos_test` is recreated by the global setup)
3. `npm test -w @examos/web`
4. `npm run security:audit` — must report 0 vulnerabilities
5. Start the demo (`npm run demo`, then `npm run dev` and `npm run worker`) and run `npm run security:probes` — must report 18/18 (or more if probes were added)
6. If any step fails, fix it before reporting; never report partial success as green.
7. Summarise: counts per suite, audit result, probe result, and any checklist rows whose status changed.
