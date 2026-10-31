---
description: Walk the full ExamOS chain on the demo tenant to prove nothing regressed (readiness → admission → writing → proctoring → seal → marking → approval → publication → booklet → ERP/mail)
---

Automated version of steps 3–7 (every role through the real UI, lockdown signals and camera presence included):
`xvfb-run -a env REHEARSAL_HEADED=1 node apps/web/e2e/exam-day-rehearsal.cjs <outDir>` (add `REHEARSAL_VIDEO=1` for a captioned MP4). Before it, `npm run smoke` checks the running stack.

1. `npm run demo`; start API, web and worker.
2. As examcell@demo.local: create a MID_1 exam (BASIC_BROWSER) and author its paper, submit the paper for review; as chief@demo.local (Paper Reviewer): approve the paper; as examcell: submit-for-review, approve, schedule, allocate student01..12, issue hall tickets, open readiness.
3. As student01: run the readiness check to READY (the system scan runs automatically); as student02: fail CLOCK_SYNC and confirm REMEDIATE with an instruction; as admin@demo.local (Controller): grant an admission exception for student02.
4. As examcell: turn on the camera presence check (exam page) before readiness, then start the exam. As student01: enter (the paper stays hidden until full screen), type and draw, leave the exam window, open a duplicate tab, change the display, press F12/Ctrl+P, reconnect after a simulated drop; confirm saves return receipts and the Chief Proctor sees each signal in words (time away, display before/after). For a SECURE_BYOD exam, follow docs/seb-rollout.md §4 on real devices.
5. As chief@demo.local: confirm warnings to the threshold, observe SUSPENDED, resume with a new epoch.
6. As student01: submit; as examcell: close the exam; run forensics; as evaluator@demo.local: enter marks with one explanation per question; as examcell: approve; as admin@demo.local (Controller): authorize publication.
7. As student01: open the ledger and the booklet; open `/verify/:attemptId/:version`; as admin@demo.local: check the mail log and webhook deliveries.
8. Record any step that fails as an In Progress/Not Started row in `docs/DEVELOPMENT_CHECKLIST.md` with the failure; do not mark anything Tested from this manual pass.
