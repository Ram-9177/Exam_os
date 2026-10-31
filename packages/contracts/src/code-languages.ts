/**
 * Every programming language a CODE question can allow, with the Judge0 CE (1.13) language id that runs it.
 *
 * The id is ExamOS's own stable name (stored in papers and answers); `judge0` is the sandbox's number for that
 * compiler/runtime and can be remapped per deployment (JUDGE_LANGUAGE_IDS) if IT installs a different Judge0 build.
 * `file` is the name the program is saved under (Java needs Main.java for `public class Main`), `group` only orders
 * the pickers. Which of these a subject may use is set per subject (courses.code_profile); a question picks from that.
 */
export const CODE_LANGUAGE_CATALOGUE = [
  { id: 'c', label: 'C', version: 'GCC 9.2.0', judge0: 50, file: 'main.c', group: 'Systems' },
  { id: 'cpp', label: 'C++', version: 'GCC 9.2.0', judge0: 54, file: 'main.cpp', group: 'Systems' },
  { id: 'c-clang', label: 'C (Clang)', version: 'Clang 7.0.1', judge0: 75, file: 'main.c', group: 'Systems' },
  { id: 'cpp-clang', label: 'C++ (Clang)', version: 'Clang 7.0.1', judge0: 76, file: 'main.cpp', group: 'Systems' },
  { id: 'rust', label: 'Rust', version: '1.40.0', judge0: 73, file: 'main.rs', group: 'Systems' },
  { id: 'go', label: 'Go', version: '1.13.5', judge0: 60, file: 'main.go', group: 'Systems' },
  { id: 'd', label: 'D', version: 'DMD 2.089.1', judge0: 56, file: 'main.d', group: 'Systems' },
  { id: 'assembly', label: 'Assembly (x86-64)', version: 'NASM 2.14.02', judge0: 45, file: 'main.asm', group: 'Systems' },
  { id: 'java', label: 'Java', version: 'OpenJDK 13.0.1', judge0: 62, file: 'Main.java', group: 'Application' },
  { id: 'kotlin', label: 'Kotlin', version: '1.3.70', judge0: 78, file: 'Main.kt', group: 'Application' },
  { id: 'scala', label: 'Scala', version: '2.13.2', judge0: 81, file: 'Main.scala', group: 'Application' },
  { id: 'groovy', label: 'Groovy', version: '3.0.3', judge0: 88, file: 'main.groovy', group: 'Application' },
  { id: 'csharp', label: 'C#', version: 'Mono 6.6.0.161', judge0: 51, file: 'Main.cs', group: 'Application' },
  { id: 'fsharp', label: 'F#', version: '.NET Core SDK 3.1.202', judge0: 87, file: 'main.fs', group: 'Application' },
  { id: 'vbnet', label: 'Visual Basic .NET', version: 'vbnc 0.0.0.5943', judge0: 84, file: 'Main.vb', group: 'Application' },
  { id: 'swift', label: 'Swift', version: '5.2.3', judge0: 83, file: 'main.swift', group: 'Application' },
  { id: 'objective-c', label: 'Objective-C', version: 'Clang 7.0.1', judge0: 79, file: 'main.m', group: 'Application' },
  { id: 'python', label: 'Python 3', version: '3.8.1', judge0: 71, file: 'main.py', group: 'Scripting and web' },
  { id: 'javascript', label: 'JavaScript', version: 'Node.js 12.14.0', judge0: 63, file: 'main.js', group: 'Scripting and web' },
  { id: 'typescript', label: 'TypeScript', version: '3.7.4', judge0: 74, file: 'main.ts', group: 'Scripting and web' },
  { id: 'php', label: 'PHP', version: '7.4.1', judge0: 68, file: 'main.php', group: 'Scripting and web' },
  { id: 'ruby', label: 'Ruby', version: '2.7.0', judge0: 72, file: 'main.rb', group: 'Scripting and web' },
  { id: 'perl', label: 'Perl', version: '5.28.1', judge0: 85, file: 'main.pl', group: 'Scripting and web' },
  { id: 'lua', label: 'Lua', version: '5.3.5', judge0: 64, file: 'main.lua', group: 'Scripting and web' },
  { id: 'bash', label: 'Bash', version: '5.0.0', judge0: 46, file: 'main.sh', group: 'Scripting and web' },
  { id: 'r', label: 'R', version: '4.0.0', judge0: 80, file: 'main.r', group: 'Data and science' },
  { id: 'octave', label: 'Octave (MATLAB-compatible)', version: '5.1.0', judge0: 66, file: 'main.m', group: 'Data and science' },
  { id: 'sql', label: 'SQL', version: 'SQLite 3.27.2', judge0: 82, file: 'main.sql', group: 'Data and science' },
  { id: 'fortran', label: 'Fortran', version: 'GFortran 9.2.0', judge0: 59, file: 'main.f90', group: 'Data and science' },
  { id: 'haskell', label: 'Haskell', version: 'GHC 8.8.1', judge0: 61, file: 'main.hs', group: 'Functional and logic' },
  { id: 'ocaml', label: 'OCaml', version: '4.09.0', judge0: 65, file: 'main.ml', group: 'Functional and logic' },
  { id: 'elixir', label: 'Elixir', version: '1.9.4', judge0: 57, file: 'main.exs', group: 'Functional and logic' },
  { id: 'erlang', label: 'Erlang', version: 'OTP 22.2', judge0: 58, file: 'main.erl', group: 'Functional and logic' },
  { id: 'clojure', label: 'Clojure', version: '1.10.1', judge0: 86, file: 'main.clj', group: 'Functional and logic' },
  { id: 'common-lisp', label: 'Common Lisp', version: 'SBCL 2.0.0', judge0: 55, file: 'main.lisp', group: 'Functional and logic' },
  { id: 'prolog', label: 'Prolog', version: 'GNU Prolog 1.4.5', judge0: 69, file: 'main.pl', group: 'Functional and logic' },
  { id: 'pascal', label: 'Pascal', version: 'FPC 3.0.4', judge0: 67, file: 'main.pas', group: 'Teaching and legacy' },
  { id: 'cobol', label: 'COBOL', version: 'GnuCOBOL 2.2', judge0: 77, file: 'main.cob', group: 'Teaching and legacy' },
  { id: 'basic', label: 'BASIC', version: 'FBC 1.07.1', judge0: 47, file: 'main.bas', group: 'Teaching and legacy' },
] as const;

export type CodeLanguage = (typeof CODE_LANGUAGE_CATALOGUE)[number]['id'];
export const CODE_LANGUAGES = CODE_LANGUAGE_CATALOGUE.map((l) => l.id) as unknown as readonly [CodeLanguage, ...CodeLanguage[]];
/** Judge0's "Multi-file program": a zip of files plus `compile` and `run` scripts written by the question setter. */
export const JUDGE0_MULTI_FILE = 89;

export function codeLanguage(id: string) {
  return CODE_LANGUAGE_CATALOGUE.find((l) => l.id === id);
}

/** A project file path: relative, no `..`, no hidden files; the scripts `compile` and `run` are reserved. */
export const PROJECT_PATH_RE = /^(?!.*\.\.)(?!\/)(?!.*\/\.)(?!\.)[A-Za-z0-9_][A-Za-z0-9_./-]{0,119}$/;
export const PROJECT_RESERVED_PATHS = ['compile', 'run'] as const;
export const PROJECT_LIMITS = { maxFiles: 30, maxFileChars: 100_000, maxTotalChars: 400_000, maxScriptChars: 2_000 } as const;

/**
 * Which languages a subject (course) uses, set by the Examination Section: e.g. CS201 Data Structures → C, C++, Java;
 * DS301 Data Science → Python, R, SQL; EC204 Signals → Octave, Python. Coding questions in that subject's exams can
 * only allow these. `default` is the language the editor and the student's workspace open in.
 */
export const DEFAULT_SUBJECT_LANGUAGES: readonly CodeLanguage[] = ['c', 'cpp', 'java', 'python'];
