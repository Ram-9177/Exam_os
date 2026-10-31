# ADR 0011 — Every language, subject language lists, build-level questions

Status: accepted (2026-10-31). Asked for by the university: "all languages", "build level", "based on the exam subject".

## What Judge0 is

Judge0 is an open-source code runner that IT installs on its own server (Docker). ExamOS sends it a program, the test input and the limits; it compiles and runs the program in an isolated sandbox (no network, CPU/memory/time limits, a fresh file system each run) and sends back what the program printed. ExamOS compares that with the expected output itself. Student code never runs on the ExamOS servers and never leaves the university's network.

## Decision

1. **Every language Judge0 CE ships** (39, `packages/contracts/src/code-languages.ts`): C/C++ (GCC and Clang), Java, Kotlin, Scala, C#, F#, VB.NET, Go, Rust, Swift, Python, JavaScript, TypeScript, PHP, Ruby, Perl, Lua, Bash, R, Octave (MATLAB-compatible), SQL (SQLite), Fortran, Haskell, OCaml, Elixir, Erlang, Clojure, Lisp, Prolog, Pascal, COBOL, BASIC, Assembly, D, Groovy, Objective-C. ExamOS stores its own stable id (`python`), not Judge0's number; `JUDGE_LANGUAGE_IDS` remaps numbers for a different Judge0 build.
2. **Languages per subject.** The Examination Section sets each subject's list (`courses.code_profile`: languages and the one the editor opens in) on the *Coding languages* page. A coding question may offer only its subject's languages (422 `LANGUAGE_NOT_IN_SUBJECT`); with no list, any language. ERP roster sync never touches it.
3. **Build-level questions (projects).** A CODE question can be a project: several files (some read-only, such as a harness, a header or test data; some editable by the student), and the setter's **build** and **run** commands. Judge0's "Multi-file program" runs it: ExamOS zips the files with `compile` and `run` scripts. Students only edit the files marked editable. Anything else they send is ignored, so they can never change the harness, the build or the tests. The sandbox has no network, so build tools only use what the judge image has installed (gcc/make, javac, python…), and third-party libraries must be put into the files.
4. **Setter proves the tests.** The answer key holds the setter's own **reference solution**. *Check with reference* runs it against every sample and hidden test. While a judge is configured, the paper cannot be approved (422 `CODE_NOT_CHECKED`) until each coding question with hidden tests has a passing check of exactly its current version. The check is tied to a fingerprint of the spec, tests and reference, so any edit needs a new check, and saving an unchanged question keeps it. A wrong expected output would otherwise cost every student marks.
5. **Examiner sees every test.** The proposal for a coding answer lists each hidden test with its input, expected output, actual output and any compiler message. This is staff only and never shown to students.

## Roles

| Role | Does |
| --- | --- |
| IT / tenant admin | deploys Judge0 (`JUDGE_URL`, `JUDGE_TOKEN`, optional `JUDGE_LANGUAGE_IDS`); *Coding languages* shows what is installed |
| Examination Section / COE | sets each subject's languages; sees sandbox status |
| Question setter | picks the languages from the subject's list (or one toolchain for a project), writes files, commands, samples, hidden tests and a reference; checks it |
| Paper reviewer | cannot approve until the checks pass |
| Student | sees only the question's languages (with versions), the project files (read-only ones locked), runs the samples a limited number of times; build errors are shown |
| Examiner | sees the system's proposal with every hidden test's result and decides; a change needs a reason |
| COE | releases results; revaluation as before |
| Chief proctor | nothing new: sample runs are bound to the admitted device session like every save |

## Consequences

- Judge0 must be deployed, its `/languages` checked against the catalogue, and load-tested before coding exams at scale. One sandbox run per hidden test per student; projects take longer because they build.
- Without a judge, nothing is run, papers are approved without checks, and examiners mark code by reading it.
