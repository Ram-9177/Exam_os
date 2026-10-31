# Safe Exam Browser (SEB) rollout

*Examination Section and IT · how a SECURE_BYOD exam locks the student's machine*

## 1. What a browser can and cannot do

A web page cannot close, block or even list other applications. ExamOS therefore runs exams two ways:

| Profile | Who locks the machine | What happens to other apps |
| --- | --- | --- |
| BASIC_BROWSER | The exam workspace in an ordinary browser | Not closed (impossible from a page). The workspace requires full screen, hides the paper whenever the window is not active, captures system keys where the browser allows (Keyboard Lock), and reports every departure — tab hidden, another app focused, full screen left, display changed, a second tab, split-screen, print or PrintScreen — to the proctors with the time away. |
| SECURE_BYOD | Safe Exam Browser | **Force-closed.** SEB quits the listed apps when it starts (`strongKill`, no prompt), keeps them closed for the whole exam, disables app switching, blocks a second display, mirroring, screen capture, screen sharing and virtual machines, and opens only the exam site. |

## 2. What the generated configuration contains

`POST /exams/:id/seb-config` (Exam Section, before the exam is LIVE) builds one settings object and emits two things from it: the `.seb` file and its **Config Key**.

- `startURL` and `quitURL`: `https://<tenant host>/student`. URL filter on, allowing only the tenant host.
- Kiosk: `createNewDesktop`, `killExplorerShell` (Windows); `enableAltTab`, `enableAltF4`, `enableCtrlEsc`, `enableStartMenu`, `enableRightMouse`, `enableF12` off; `enableAppSwitcherCheck`, `forceAppFolderInstall` (macOS); Siri and dictation off.
- Displays and capture: `allowedDisplaysMaxNumber = 1`, `allowDisplayMirroring = false`, `enablePrintScreen = false`, `allowScreenSharing = false`, `allowVirtualMachine = false`, private clipboard, spell-check off.
- `prohibitedProcesses` with `strongKill = true`, for **Windows (os 1, executable name)** and **macOS (os 0, process name + bundle identifier)**:
  - communication: Teams, Zoom, Skype, Slack, Discord, Telegram, WhatsApp, Signal, Webex, Messages, FaceTime;
  - remote access: TeamViewer, AnyDesk, RustDesk, Chrome Remote Desktop host, Remote Desktop Connection, Screen Sharing, VNC, Parsec, Splashtop;
  - capture and streaming: OBS, Camtasia, Snagit, ShareX, Bandicam, Greenshot, Lightshot, Snipping Tool, Xbox Game Bar, Loom, QuickTime Player, Screenshot;
  - AI assistants: ChatGPT, Claude, Microsoft Copilot;
  - hypervisors: VirtualBox, VMware, Parallels.
  The Exam Section adds more per exam: `Name.exe` for Windows, a bundle id (`com.vendor.app`) for macOS. The full list is `DEFAULT_PROHIBITED_APPS` in `apps/api/src/modules/seb/settings.ts`.
- Optional quit password, stored in the file only as `hashedQuitPassword` (SHA-256).

**Config Key** = lower-case hex SHA-256 of the settings as JSON, without `originatorVersion`, keys sorted case-insensitively at every level, no whitespace (the SEB specification). The test suite recomputes it independently from the downloaded file.

## 3. How the server enforces it

| Door | Rule |
| --- | --- |
| Readiness `CLIENT_VERSION` | PASS (source `SECURE_CLIENT`) only with a valid SEB key; otherwise REMEDIATE `SEB_REQUIRED` / `SEB_CONFIG_KEY_MISMATCH` |
| Entry grant, admission, reconnect | **Refused** (`403 SECURE_CLIENT_REQUIRED`) without a valid key. The refusal is recorded first as a server-observed `SECURE_CLIENT_MISSING` signal; a refused admission does not use up the one-time grant |
| Heartbeat during the exam | A missing key raises `SECURE_CLIENT_MISSING` for a proctor (at most one per minute). Saves are never refused because of a header |

A valid key arrives one of two ways:

- **Headers** (SEB for Windows adds them to every request): `X-SafeExamBrowser-ConfigKeyHash = SHA-256(absolute request URL + Config Key)`, and, when Browser Exam Keys are registered, `X-SafeExamBrowser-RequestHash = SHA-256(URL + BEK)`.
- **JavaScript API** (SEB for macOS/iOS cannot add headers to `fetch`): the page reads `SafeExamBrowser.security.configKey` / `browserExamKey` and sends them with the page URL they were computed for (`X-SEB-Page-Url`, `X-SEB-Config-Key-Hash`, `X-SEB-BEK-Hash`). The page URL must be on the exam host.

**Honesty.** The Config Key is derived from a file students can read, so a matching hash shows the request came from something that knows the configuration — SEB in every normal case — not that the machine is locked. Registering **Browser Exam Keys** (from the SEB Config Tool, one per approved SEB build) raises the bar: the key then also covers the SEB build. Neither is recorded as proof of a locked machine; the room invigilator remains part of the control.

The configuration and the keys are **frozen once the exam is LIVE** (`409 SEB_CONFIG_FROZEN`): changing them would lock every student out mid-exam.

## 4. Rollout checklist

1. Exam profile `SECURE_BYOD`. Generate the configuration on the exam page (quit password and extra apps optional).
2. **Rehearsal, on every approved device type** (Windows 10/11 and macOS, current SEB 3.x):
   - download the `.seb` file; open it in the SEB Config Tool and confirm it shows the **same Config Key** as the exam page;
   - open it in SEB, sign in, run the readiness check: `Exam client` must be Ready;
   - start Teams/Zoom/AnyDesk/OBS before opening SEB and confirm SEB closes them;
   - try a second monitor, PrintScreen and Alt-Tab/Cmd-Tab.
   If the Config Tool shows a different key, paste the Config Tool's key on the exam page (`PUT /exams/:id/client-policy {sebConfigKey}`) and distribute the institution's own `.seb` file instead; record the SEB version in the rehearsal notes.
3. Optionally register the Browser Exam Keys of the approved SEB builds.
4. Students download the `.seb` file from their exam card (an authenticated download), open it, sign in inside SEB, and complete readiness there.
5. Exam day: open readiness, start the exam. Students in an ordinary browser are refused at entry and appear in the proctor queue as "Safe Exam Browser missing".

## 5. Not covered

MANAGED_ENDPOINT (university lab images) uses the lab subnet check (`allowedSubnets`), not SEB. Process lists reported by SEB itself (`DISALLOWED_APP_DETECTED`) are not wired: SEB force-closes the apps and the exam is refused outside SEB, so the server never needs the list.
