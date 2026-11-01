# ADR 0012 — Screen watch and AI-tool signals

Status: accepted (2026-11-01). Asked for by the university: "see the screen, check for any AI being used on screen, and flag it".

## What can and cannot be seen

| AI help the student might use | Where | What catches it |
| --- | --- | --- |
| AI websites (ChatGPT, Gemini, Claude, Perplexity…) in another tab | browser | Safe Exam Browser allows only the exam site. In browser mode: leaving the tab (FOCUS_LOST), a second tab (MULTIPLE_TABS), split screen (WINDOW_RESIZED). **Screen watch** shows it to a person. |
| AI browser extensions (sidebars, "solve this", writing assistants) | inside the exam page | **PAGE_TAMPERED**: frames, scripts, custom elements or extension files added to the page. **TEXT_NOT_TYPED**: answer text put in by a script, or a big block replacing typing. |
| Desktop AI apps (ChatGPT, Claude, Copilot, Perplexity…) | another window | Safe Exam Browser force-closes them (prohibited processes, strongKill). In browser mode: focus loss, and **screen watch** shows the window. |
| "Invisible" AI overlays (interview/exam helpers that hide from screen capture) | on top of everything | They ask the OS to be left out of screenshots, so **no screen picture can ever show them**, and they do not take focus. Only Safe Exam Browser stops them: it closes them by process (list extended, Examination Section adds more) and, on Windows, runs the exam on its own desktop where other apps' windows do not appear. Exams where this matters must use SECURE_BYOD (SEB). |
| A phone or a second person | off the computer | Camera presence (ADR 0008) and invigilators. |

## Decision

1. **Screen watch** (opt-in per exam, `policy.proctoring.screenWatch = {intervalSeconds 15–600}`, a new policy version and SCREEN consent):
   - the workspace asks for the **entire screen** (`getDisplayMedia`, `displaySurface: 'monitor'`); a window or tab is refused;
   - the paper stays hidden until the screen is shared and is hidden again if sharing stops;
   - a downscaled JPEG (≤ 1280 px wide, ≤ 400 KB) goes to the server every interval: only the student's own **ACTIVE** attempt, from the admitted device, JPEG bytes only, 12 per minute;
   - proctors see the pictures newest first, which were not the entire screen, and **gaps measured by the server's clock** (no picture for more than twice the interval);
   - viewing is audited (`proctor.screen_frames_viewed`);
   - a phone or tablet that cannot share is put on record but not blocked.
2. **New signal classes**, all human-review-only (never countable without a named proctor's decision, AGENTS rule 5):
   - SCREEN_SHARE_ENDED (stopped, refused, not the entire screen, unsupported);
   - PAGE_TAMPERED;
   - TEXT_NOT_TYPED (untrusted input events; `insertReplacementText` / drop / large `insertText` blocks).
   - A "field grew a lot in one keystroke" rule was rejected: the editor swaps field contents when the student changes question, which would flag innocent students.
3. **Safe Exam Browser** prohibited processes add Microsoft 365 Copilot, Perplexity, Cluely, Interview Coder, Grammarly desktop, Raycast and Notion. Some executable names and bundle identifiers are best-known values and must be confirmed on real devices in the SEB rehearsal (docs/seb-rollout.md).
4. **No automatic judgement of pictures.** The system does not try to recognise AI tools in screenshots; it is unreliable and would produce accusations nobody could explain. People look.

## Consequences

- Screen pictures are personal data. Before turning screen watch on:
  - the university's data-protection assessment must cover it;
  - a retention period must be decided (deletion of old pictures is not automated yet; pictures are in the `screens` storage bucket and `screen_frames`).
- Storage: one picture of ~50–200 KB per student per interval. 1,000 students for 3 hours at 60 s is about 180,000 pictures (~20 GB).
- Students on phones/tablets cannot share a screen; exams with screen watch should be taken on laptops/desktops.
