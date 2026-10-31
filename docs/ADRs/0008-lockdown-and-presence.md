# ADR 0008 — Lockdown: browser mode, Safe Exam Browser, and on-device camera presence

Status: accepted (2026-10-31). Supersedes the §11 default "SECURE_BYOD with SEB only; no attestation" in detail, not in spirit.

## Context

The university asked that once an exam starts, other applications are restricted and force-closed, and that changing the screen or tab is flagged — "not only the face/camera, the display as well". A web page cannot close or list other applications; a page also cannot see the screen outside its own window.

## Decision

1. **Two lockdown levels, by security profile.**
   - *BASIC_BROWSER*: the workspace requires full screen before the paper is shown (a refusal by the device never traps the student; it is recorded), hides the paper whenever the window is not active, uses Keyboard Lock in full screen where the browser supports it, and reports every departure as a signal with its context (tab hidden vs another app, time away, display before/after, tabs open, window size). Print, DevTools and view-source shortcuts are blocked and reported; a paste from outside the exam is refused and reported.
   - *SECURE_BYOD*: Safe Exam Browser force-quits prohibited apps on Windows and macOS and keeps them closed, blocks switching, second displays, mirroring, capture and VMs, and allows only the exam site. The server refuses entry, admission and reconnect without a valid SEB key (record, then refuse) and flags a live session that loses it. Details: `docs/seb-rollout.md`.
2. **Signals remain context for a human** (ADR 0005). New classes `DISPLAY_CHANGED`, `FACE_NOT_VISIBLE` (client) and `SECURE_CLIENT_MISSING` (server-only) are human-review only. Server-only classes are refused at client ingest. Signal metadata is bounded (2 KB) and shown to the proctor in plain words next to the server's receipt time.
3. **Camera presence runs on the student's device, opt-in per exam.** A face detector (MediaPipe BlazeFace, Apache-2.0, WASM, served from our origin) counts faces once a second; only signals leave the device — never an image. Absence ≥ 8 s or a covered camera → `FACE_NOT_VISIBLE` (with the total on return; three face frames in a row end an absence, so a single false detection does not); ≥ 2 faces for 3 s → `MULTIPLE_PERSON_POSSIBLE`; a camera that cannot start or stops → `CAMERA_UNAVAILABLE` (technical, never countable). Turning it on adds the CAMERA consent and a new policy version; it is frozen once the exam is live. The student sees a self-view that says nothing is sent or kept.
4. **No third-party traffic from the exam client.** The detector's runtime sends usage telemetry to a Google endpoint; a same-origin fetch guard installed with the detector refuses it. Deployments should also send `Content-Security-Policy: connect-src 'self'` (and allow `'wasm-unsafe-eval'` for the detector).

## Consequences

- Browser mode cannot stop a determined student using a second device or an app that does not take focus; it makes every departure visible to a person. SEB is the profile for exams where apps must be closed.
- The SEB Config Key derivation must be confirmed against real SEB builds at the rehearsal (the readiness check refuses a mismatch before the exam, never during it).
- Camera presence still needs the institution's data-protection assessment (plan §11) before use; no media pipeline (Phase 5) is introduced by this ADR.
- Headless test browsers keep every page "visible and focused"; the browser rehearsal fires the same events a real switch fires and labels it as simulated, while unit tests cover the hook.
