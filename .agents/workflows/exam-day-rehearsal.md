---
description: Walk the full ExamOS chain on the demo tenant to prove nothing regressed (readiness → admission → writing → proctoring → seal → marking → approval → publication → booklet → ERP/mail)
---

1. `npm run demo`; start API, web and worker.
2. As examcell@demo.local: create a MID_1 exam (BASIC_BROWSER), submit-for-review, approve, schedule, allocate student01..12, issue hall tickets, open readiness.
3. As student01: run the readiness check to READY; as student02: fail CLOCK_SYNC and confirm REMEDIATE with an instruction; as controller@demo.local: grant an admission exception for student02.
4. As examcell: start the exam. As student01: enter, type and draw, trigger FOCUS_LOST twice, reconnect after a simulated drop; confirm saves return receipts and the timeline shows one grouped incident.
5. As chief@demo.local: confirm warnings to the threshold, observe SUSPENDED, resume with a new epoch.
6. As student01: submit; as examcell: close the exam; run forensics; as evaluator@demo.local: enter marks with one explanation per question; as examcell: approve; as controller: authorize publication.
7. As student01: open the ledger and the booklet; open `/verify/:attemptId/:version`; as admin@demo.local: check the mail log and webhook deliveries.
8. Record any step that fails as an In Progress/Not Started row in `docs/DEVELOPMENT_CHECKLIST.md` with the failure; do not mark anything Tested from this manual pass.
