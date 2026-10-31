# ADR 0010 — Maths, health and coding questions

Status: accepted (2026-10-31). Decisions by the university: no negative marking anywhere; two-examiner marking depends on the exam (per-exam double evaluation, already available); coding is needed for engineering.

## Decision

New question kinds, all inside the existing flow (system proposes → named examiner decides and explains any change → Exam Cell approves → COE releases → revaluation by the COE):

| Kind | Student answers with | System proposal |
| --- | --- | --- |
| MCQ | option buttons (`choice` block) | answer key |
| MCQ_MULTI | checkboxes | credit = right chosen/all right − wrong chosen/all wrong, **never below zero**; ticking everything earns nothing |
| NUMERIC | `final` answer box + working | expected values within tolerance; a **unit** in the key is required in the answer (a dose in g is not a dose in mg) |
| MATH | `final` answer box + working | **mathematical equivalence** (random-point evaluation of a small expression parser: 2(x+1) ≡ 2x+2, sin²x+cos²x ≡ 1) |
| CODE | code editor (C, C++, Java, Python) | share of **hidden test** weight passed in the sandbox |

- **Answer marks and method marks** (NUMERIC, MATH): `answerMarks` in the key; method marks follow a right answer, and with a wrong answer go to the examiner (errors carried forward are the examiner's judgement).
- **Must-not-miss rubric steps** (health): a step marked `critical` that is missing means the question gets a proposal of 0 with a warning; the examiner reads and decides.
- **Coding sandbox:** programs never run in ExamOS. A self-hosted **Judge0** (isolated: no network, CPU/memory/time limits) at `JUDGE_URL` runs them. Students may run the visible **sample tests** a limited number of times per question during the exam; the **hidden tests** run after sealing, by a worker loop with a lease and retries, and the proposal refreshes. Without a judge, coding answers are marked by examiners and students are told sample runs are unavailable.
- Answer blocks `choice`, `final`, `code` are validated by schema on every save.

## Consequences

- Paper setters enter the keys: options and correct ones, expected values/unit/answer marks, expressions, sample and hidden tests with weights.
- Judge0 must be deployed and load-tested before coding exams at scale (one sandbox run per hidden test per student).
- Handwritten/drawn working is never marked by the system.
