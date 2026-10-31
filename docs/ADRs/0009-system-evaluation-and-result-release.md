# ADR 0009 — System evaluation, human approval, one release, revaluation by the COE

Status: accepted (2026-10-31).

## Context

The university wants answers evaluated by the system against the paper's rubric, with difficulty per rubric step, while students — who fear "system evaluation" — must be able to trust the result. After results are out they must not change, except through a student's revaluation application handled by the Controller of Examinations (COE).

## Decision

1. **Marking steps with difficulty.** Each rubric step has marks, a description, key terms (`a|b` = alternatives) and a difficulty 1–10 (default 5). A step at difficulty *d* gives full credit at `1 − (d−1)·5 %` of its key terms (100 % at 1, 80 % at 5, 55 % at 10); partial coverage earns proportionally, rounded to the nearest half mark, ties up. MCQ use an answer key read only from explicit choices; NUMERIC use expected values with a tolerance. Drawings and steps without key terms get no proposal. Length never earns marks.
2. **The system evaluates first, a person decides.** When forensics hand a script to marking, the system's evaluation is stored (`mark_proposals`) and shown in the examiner's queue (proposed total, "read carefully", "for you to mark"). The examiner opens every script, reads the answers, keeps or changes each proposal; a change needs a written reason (server-enforced, recomputed server-side). Proposal, method and reason are kept in the result version. No mark is ever recorded without a named examiner.
3. **One release.** Results of an exam go out together: `POST /exams/:id/publish-results` by the COE, only for a CLOSED exam and only when every script is approved; held candidates are withheld. Before it no single result can be published (`MASS_PUBLICATION_REQUIRED`); after it only a released hold or a revaluation outcome is.
4. **Frozen after release; revaluation by the COE.** A published result cannot be re-marked. A student applies for revaluation within 7 days; only the COE (`revaluation:decide`, no longer the Exam Section) approves or rejects. Re-marking must explain every change from the published mark (`REVALUATION_REASON_REQUIRED`); the Exam Cell approves the new version and the COE publishes it; the ledger keeps the superseded record.
5. **Students are told how.** The published booklet explains the process in plain words and how to apply for revaluation.

## Consequences

- Rubric key terms and difficulty are part of paper setting; questions without them are marked by examiners unaided.
- The release waits for the slowest script; holds are the only way to release without a candidate.
- Students who never entered the exam have no script and no result; recording them as absent is separate work.
