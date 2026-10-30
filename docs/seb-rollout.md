# Safe Exam Browser (SEB) Rollout & Client Hardening Guide

*St. Mary's University Examination Section · Operational Standard & IT Architecture*

---

## 1. Overview & Architecture

ExamOS enforces a layered security architecture for high-stakes university examinations (`SECURE_BYOD` and `MANAGED_ENDPOINT`). The client-side integrity gate is anchored by **Safe Exam Browser (SEB)**, an open-source, standards-compliant lockdown browser that converts personal computers and lab workstations into secure examination terminals.

```
+-------------------------------------------------------------------------+
|                          Candidate Workstation                          |
|                                                                         |
|  +-------------------------------------------------------------------+  |
|  |                 Safe Exam Browser (Kiosk Shell)                   |  |
|  |  * Strict Single-Window Kiosk Mode                                |  |
|  |  * Prohibited Process Blocker (Discord, Teams, TeamViewer, etc.)  |  |
|  |  * Virtual Machine & Hypervisor Blocker (VMware, VirtualBox, etc.)|  |
|  |  * Private In-Memory Clipboard (Host Clipboard Disabled)          |  |
|  |  * Screen Sharing, Recording & Secondary Display Prohibited       |  |
|  +---------------------------------+---------------------------------+  |
|                                    |                                    |
|                                    | X-SafeExamBrowser-ConfigKeyHash    |
|                                    | = SHA256(requestUrl + ConfigKey)   |
+------------------------------------+------------------------------------+
                                     |
                                     v HTTPS
+-------------------------------------------------------------------------+
|                             ExamOS API                                  |
|                                                                         |
|  * Validates SHA256(requestUrl + policy.sebConfigKey)                   |
|  * Matches Config Key against Exam Policy                               |
|  * Records CLIENT_VERSION check as PASS / SECURE_CLIENT                 |
|  * If forged or missing: status REMEDIATE / SEB_CONFIG_KEY_MISMATCH     |
+-------------------------------------------------------------------------+
```

---

## 2. Supported Device Matrix

All candidate workstations must meet the following minimum system requirements:

| Operating System | Supported Versions | Minimum Client Build | Delivery Profile |
|---|---|---|---|
| **Microsoft Windows** | Windows 10 (21H2+) 64-bit, Windows 11 (22H2+) | SEB 3.7.0+ (SEB_Win_3.8.0 recommended) | SECURE_BYOD / MANAGED_ENDPOINT |
| **Apple macOS** | macOS 12 (Monterey), 13 (Ventura), 14 (Sonoma), 15 (Sequoia) | SEB 3.3.0+ (SEB_Mac_3.3.2 recommended) | SECURE_BYOD / MANAGED_ENDPOINT |
| **Apple iPadOS** | iPadOS 16.0+ | SEB 3.0+ | SECURE_BYOD (Tablet halls) |
| **Linux (Ubuntu/Debian)** | LTS 22.04 / 24.04 | SMRU Lab Kiosk Package (SEB-compatible) | MANAGED_ENDPOINT only |
| **Virtual Machines / Emulators** | Any (VMware, VirtualBox, Parallels, Hyper-V, QEMU, KVM) | **PROHIBITED** | Refused by SEB Kiosk |

---

## 3. SEB Security Policy Parameters

When the Examination Section generates an SEB configuration (`POST /api/v1/exams/:id/seb-config`), the server emits an authentic Apple XML Property List (`.seb`) with the following enforced keys:

| Setting Key | Value | Security Impact |
|---|---|---|
| `startURL` | `https://${host}/student` | Restricts browser entry point strictly to the university exam portal. |
| `sendBrowserExamKey` | `<true/>` | Instructs SEB to compute and transmit verification hashes on all HTTP requests. |
| `kioskMode` | `<true/>` | Disables task switching (Alt+Tab, Cmd+Tab), Start Menu, Dock, and system key chords. |
| `enablePrivateClipboard` | `<true/>` | Restricts clipboard buffer to the active exam session; external copy-paste is blocked. |
| `enablePrintScreen` | `<false/>` | Blocks system screenshot shortcuts (PrtScn, Win+Shift+S, Cmd+Shift+3/4). |
| `allowPrint` | `<false/>` | Disables physical and digital (Print to PDF) printing. |
| `allowScreenSharing` | `<false/>` | Prohibits screen capture APIs and desktop broadcasting. |
| `allowVirtualMachine` | `<false/>` | Refuses to launch if hypervisor signatures or VM guest additions are detected. |
| `allowRemoteSession` | `<false/>` | Terminates connection if RDP, VNC, AnyDesk, or TeamViewer sessions are active. |
| `prohibitedProcesses` | See below | Actively terminates background communication and screen sharing utilities. |

### Prohibited Processes List
SEB actively monitors the operating system task table and terminates the exam session if any of the following executables execute:
- **Chat & Collaboration**: `discord`, `teams`, `slack`, `skype`, `zoom`, `whatsapp`, `telegram`
- **Remote Desktop & Screen Sharing**: `anydesk`, `teamviewer`, `chrome-remote-desktop`, `vncviewer`
- **Screen Recorders**: `obs`, `obs64`, `camtasia`, `snagit`
- **Hypervisors**: `vmware`, `virtualbox`, `parallels`, `qemu`

---

## 4. Cryptographic Handshake & Verification

### The Safe Exam Browser Config Key
1. The server compiles the deterministic `.seb` XML configuration file.
2. The server calculates the **Config Key** as the SHA-256 hex string:
   $$\text{ConfigKey} = \text{SHA256}(\text{CanonicalPlistXML})$$
3. The Config Key is stored directly in `exams.policy.sebConfigKey`.
4. When the candidate workstation executes SEB, the client computes the request header on every HTTP request:
   $$\text{X-SafeExamBrowser-ConfigKeyHash} = \text{SHA256}(\text{RequestURL} + \text{ConfigKey})$$
5. The ExamOS server independently computes the expected hash using its own authoritative URL and `exams.policy.sebConfigKey`. If the hashes match, the precheck test records:
   - `status`: `PASS`
   - `source`: `SECURE_CLIENT`
6. Any mismatch (running outside SEB, wrong configuration, tampered URL) triggers:
   - `status`: `REMEDIATE`
   - `diagnosticCode`: `SEB_CONFIG_KEY_MISMATCH`
   - `remediationCode`: `OPEN_IN_SECURE_CLIENT`

---

## 5. Managed Endpoint Lab Network Attestation

For university campus computer centres (`MANAGED_ENDPOINT`), candidates take exams from designated university subnets:
- Exam policies define `allowedSubnets`: e.g. `['10.50.0.0/16', '192.168.100.0/24']`.
- The server inspects the candidate connection IP.
- Connections originating within authorized lab subnets verify `CLIENT_VERSION` with source `SECURE_CLIENT`.
- Off-campus connections or non-lab devices are refused with diagnostic `MANAGED_ENDPOINT_REQUIRED` and remediation `CONNECT_FROM_LAB_NETWORK`.

---

## 6. Staff & Exam Cell Workflow

### 1. Generating or Updating Exam SEB Configuration
1. Navigate to **Exams** -> Select target exam -> **Overview** tab.
2. Under **Safe Exam Browser & Client Policy**, review the current **Config Key**.
3. Click **Generate SEB Config** (or **Rebuild SEB Config** if policy changed).
4. Click **Download .seb file** to retain an archival copy for lab deployment.

### 2. Candidate Exam Day Instructions
1. Prior to exam day, candidates install the official Safe Exam Browser from the university software portal or [safeexambrowser.org](https://safeexambrowser.org).
2. On exam day, candidates sign in to the student portal and click **Download .seb configuration**.
3. Double-clicking the `.seb` file automatically opens Safe Exam Browser in kiosk mode, connecting directly to the exam room lobby.
4. During readiness check, the `CLIENT_VERSION` test automatically passes with the cryptographic `SECURE_CLIENT` green badge.

