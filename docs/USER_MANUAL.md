# SMRU ExamOS — Comprehensive User Manual & End-to-End System Guide

**St. Mary's University Examination Operating System (SMRU ExamOS)**  
*Multi-Tenant, Security-Hardened, AI-Assisted University Examination Platform*

---

## Table of Contents

1. [Quick-Start & Credentials Directory](#1-quick-start--credentials-directory)
   - [Access URLs & Server Endpoints](#access-urls--server-endpoints)
   - [Staff Accounts & Duty Bundles](#staff-accounts--duty-bundles)
   - [Student Cohort Accounts (12 Candidates)](#student-cohort-accounts-12-candidates)
   - [Seeded Multi-Phase Exams](#seeded-multi-phase-exams)
2. [Role Manual 1: Platform & Tenant Administrator](#2-role-manual-1-platform--tenant-administrator)
   - [Overview & Permissions](#overview--permissions)
   - [Staff Seats & Duty Bundles (4/4 Limit)](#staff-seats--duty-bundles-44-limit)
   - [Controller Digital E-Signature Seal](#controller-digital-e-signature-seal)
   - [ERP (UOS) Integration & Roster Sync](#erp-uos-integration--roster-sync)
   - [Outbox Email & Webhook Delivery Health](#outbox-email--webhook-delivery-health)
   - [Cryptographic Audit Log & Timeline](#cryptographic-audit-log--timeline)
3. [Role Manual 2: Examination Cell Operator](#3-role-manual-2-examination-cell-operator)
   - [Overview & Duties](#overview--duties)
   - [Creating Examinations & Security Profiles](#creating-examinations--security-profiles)
   - [Setting Multi-Section Question Papers & Rubrics](#setting-multi-section-question-papers--rubrics)
   - [Safe Exam Browser (SEB) XML Generation](#safe-exam-browser-seb-xml-generation)
   - [Cohort Allocations & Dynamic Dual-Signature Hall Tickets](#cohort-allocations--dynamic-dual-signature-hall-tickets)
   - [Precheck Readiness Board & Controller Waivers](#precheck-readiness-board--controller-waivers)
   - [Examination Lifecycle Transitions](#examination-lifecycle-transitions)
   - [Managing Candidate Integrity Holds & Approvals](#managing-candidate-integrity-holds--approvals)
   - [Revaluation Applications Processing](#revaluation-applications-processing)
4. [Role Manual 3: Chief Reviewer & Chief Proctor](#4-role-manual-3-chief-reviewer--chief-proctor)
   - [Overview & Duties](#overview--duties-1)
   - [Question Paper Review & Approval](#question-paper-review--approval)
   - [Live Proctoring Console](#live-proctoring-console)
   - [Incident Signals, Confirmations & Dismissals](#incident-signals-confirmations--dismissals)
   - [Warning Threshold Suspension](#warning-threshold-suspension)
   - [Authorized Resume & Deadline Extensions](#authorized-resume--deadline-extensions)
5. [Role Manual 4: Examiner, Evaluator & Moderator](#5-role-manual-4-examiner-evaluator--moderator)
   - [Overview & Duties](#overview--duties-2)
   - [Double-Blind Evaluation Queue](#double-blind-evaluation-queue)
   - [Evaluating Answers, LaTeX Formulas & Vector Canvas](#evaluating-answers-latex-formulas--vector-canvas)
   - [Criteria Rubric Scoring & Justifications](#criteria-rubric-scoring--justifications)
   - [Moderation Divergence Detection](#moderation-divergence-detection)
6. [Role Manual 5: Student / Candidate](#6-role-manual-5-student--candidate)
   - [Overview & Candidate Portal](#overview--candidate-portal)
   - [Student Profile, Photo Upload & ID Card QR](#student-profile-photo-upload--id-card-qr)
   - [Candidate Digital E-Signature](#candidate-digital-e-signature)
   - [Official Hall Ticket PDF Download](#official-hall-ticket-pdf-download)
   - [Safe Exam Browser (.seb) Configuration Download](#safe-exam-browser-seb-configuration-download)
   - [15-Minute Readiness Precheck Sequence](#15-minute-readiness-precheck-sequence)
   - [Live Exam Workspace (OT Typing & Math Whiteboard)](#live-exam-workspace-ot-typing--math-whiteboard)
   - [Lifelong Academic Ledger & Graded Answer Booklets](#lifelong-academic-ledger--graded-answer-booklets)
   - [Submitting a Revaluation Request](#submitting-a-revaluation-request)
7. [The "Full Show" Master Walkthrough](#7-the-full-show-master-walkthrough)
   - [Chronological 12-Act Rehearsal Script](#chronological-12-act-rehearsal-script)
8. [System Architecture & Security Invariants](#8-system-architecture--security-invariants)
   - [Zero-Security-Shortcut Guarantee](#zero-security-shortcut-guarantee)
   - [Database Row-Level Security (`withTenantTx`)](#database-row-level-security-withtenanttx)
   - [Append-Only Audit & Forensic Trails](#append-only-audit--forensic-trails)

---

## 1. Quick-Start & Credentials Directory

### Access URLs & Server Endpoints

| Service | URL | Notes |
| :--- | :--- | :--- |
| **Web Application** | `http://localhost:5173` | React 19 + Vite + Tailwind CSS 4 frontend |
| **API Server** | `http://localhost:4000` | Express 4 + Node 22 + PostgreSQL 16 + Redis 7 |
| **Demo Tenant Domain** | `localhost` or `demo.local` | Auto-resolves to demo tenant via host header |
| **Tenant ID** | Auto-provisioned | Slug: `demo` |

---

### Staff Accounts & Duty Bundles

ExamOS enforces a strict institutional invariant of **4 active staff seats per tenant**. Each staff account is assigned a Duty Bundle that maps university governance roles to fine-grained cryptographic permissions:

| Email | Password | Full Name | Duty Bundle | Core Responsibilities |
| :--- | :--- | :--- | :--- | :--- |
| `admin@demo.local` | `Demo-Admin!2026` | Demo Admin | `ADMIN_CONTROLLER` | Tenant Administration, Controller of Examinations, E-Signature, ERP Config, Academic Analytics |
| `examcell@demo.local` | `Demo-Staff!2026` | Exam Office Lead | `EXAM_OFFICE` | Exam Creation, Paper Authoring, Allocations, Hall Tickets, Lifecycles, Result Approvals |
| `chief@demo.local` | `Demo-Staff!2026` | Chief Reviewer | `CHIEF_REVIEWER` | Paper Vetting, Review Approvals, Live Proctoring Desk, Warning Confirmations, Candidate Resume |
| `evaluator@demo.local` | `Demo-Staff!2026` | Dr. Evaluation Lead | `EXAMINER` | Double-Blind Answer Evaluation, Criteria Rubrics Grading, Score Moderation |

---

### Student Cohort Accounts (12 Candidates)

All 12 students belong to **B.Tech Computer Science & Engineering (Semester 5)**.  
**Universal Student Password:** `Demo-Student!2026`

| Student ID | Full Name | Email | Reg Number | Seeded State Across Multi-Phase Exams |
| :--- | :--- | :--- | :--- | :--- |
| **Student 01** | Aarav Sharma | `student01@demo.local` | `22CSE001` | Precheck Ready; Live Active; Evaluated (46/50, Grade O); Booklet Available |
| **Student 02** | Diya Patel | `student02@demo.local` | `22CSE002` | Precheck Ready; Proctor Warned (Tab switch); Evaluated (41/50, Grade A+); Revaluation Requested |
| **Student 03** | Rohan Iyer | `student03@demo.local` | `22CSE003` | Precheck Ready; Concurrent Device Mismatch Alert; Flagged with Integrity Hold |
| **Student 04** | Ananya Reddy | `student04@demo.local` | `22CSE004` | Precheck Ready; Warning Threshold Suspended; Resumed with +5m Extension |
| **Student 05** | Vikram Malhotra | `student05@demo.local` | `22CSE005` | Precheck Ready; Live Answering Active; Evaluated (31/50, Grade B+) |
| **Student 06** | Pooja Verma | `student06@demo.local` | `22CSE006` | Precheck Ready; Live Answering Active; Evaluated (27/50, Grade B) |
| **Student 07** | Karthik Nair | `student07@demo.local` | `22CSE007` | Precheck In-Progress (Steps 1-3 verified) |
| **Student 08** | Sneha Kulkarni | `student08@demo.local` | `22CSE008` | Precheck In-Progress (Practice saves tested) |
| **Student 09** | Aditya Joshi | `student09@demo.local` | `22CSE009` | Dual-Monitor Blocked -> Controller Exception Waived -> Retried and Ready |
| **Student 10** | Meera Rao | `student10@demo.local` | `22CSE010` | Client Version Incompatible (`REMEDIATE` required) |
| **Student 11** | Siddharth Gupta | `student11@demo.local` | `22CSE011` | Not Started (Eligible, Hall Ticket issued) |
| **Student 12** | Neha Choudhury | `student12@demo.local` | `22CSE012` | Not Started (Eligible, Hall Ticket issued) |

---

### Seeded Multi-Phase Exams

The demo database provisions **5 distinct exams**, each actively frozen at a specific operational lifecycle state so you can test all screens immediately:

| Exam Code | Course | Lifecycle Phase | Security Profile | Duration & Marks | Seeded Features & Activity |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`CS302-SEM`** | Database Systems | **`SCHEDULED`** | `SECURE_BYOD` | 180 min · 70 marks | Sets A & B configured; Safe Exam Browser (`.seb`) file ready for download; Hall tickets issued |
| **`CS301-MID1`** | Operating Systems | **`PRECHECK`** | `BASIC_BROWSER` | 60 min · 20 marks | Readiness Board active; 7 Ready, 2 In-Progress, 1 Waived Exception, 1 Remediate, 2 Not Started |
| **`CS303-LIVE`** | Computer Networks | **`LIVE`** | `BASIC_BROWSER` | 90 min · 30 marks | Active workspace; Vector canvas math diagrams; Incidents logged; Warnings confirmed; Suspend/Resume active |
| **`CS304-EVAL`** | Design & Analysis of Algorithms | **`CLOSED`** | `BASIC_BROWSER` | 60 min · 25 marks | Sealed attempts; Forensics passed; Examiner marking queue; Rubrics grading; Integrity hold applied |
| **`CS305-PUB`** | Software Engineering | **`PUBLISHED`** | `BASIC_BROWSER` | 120 min · 50 marks | Approved & authorized; Lifelong Ledger grades; Answer Booklet PDFs; Student Revaluation request active |

---

## 2. Role Manual 1: Platform & Tenant Administrator

**Persona:** `admin@demo.local` (`Demo-Admin!2026`)  
**Portal Route:** `/admin`

### Overview & Permissions
The Tenant Administrator acts as the chief administrative authority for the campus tenant. They oversee staff seat allocation, maintain the University Controller of Examinations official seal/e-signature, monitor ERP integration status, verify outbox notification health, and audit cryptographic chain logs.

```
                    ┌──────────────────────────────┐
                    │     Tenant Administrator     │
                    │      admin@demo.local        │
                    └──────────────┬───────────────┘
                                   │
         ┌─────────────────────────┼─────────────────────────┐
         ▼                         ▼                         ▼
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│   Staff Seats    │      │ Controller Seal  │      │  ERP Integration │
│  4 Active Limit  │      │   E-Signature    │      │    UOS Roster    │
└──────────────────┘      └──────────────────┘      └──────────────────┘
         │                         │                         │
         ▼                         ▼                         ▼
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│   Mail Health    │      │  Audit Security  │      │ Academic Reports │
│ Transactional/Blk│      │ SHA-256 Chains   │      │ Pass Rates / GPA │
└──────────────────┘      └──────────────────┘      └──────────────────┘
```

---

### Staff Seats & Duty Bundles (4/4 Limit)
1. Navigate to `/admin`.
2. Locate the **Staff Seats & Licensing** card.
3. Observe `4 / 4 seats active`.
4. ExamOS strictly enforces institutional governance:
   - Attempting to add a 5th active staff account without deactivating an existing one is rejected by both UI validation and PostgreSQL row-level checks.
   - Staff roles are assigned exclusively through **Duty Bundles**:
     - `EXAM_OFFICE`: Examination Section staff who manage schedules, papers, candidates, and approvals.
     - `CHIEF_REVIEWER`: Chief review authority for question paper sign-offs and live invigilation.
     - `EXAMINER`: Subject matter examiners who evaluate sealed papers and criteria rubrics.
     - `ADMIN_CONTROLLER`: Institutional controller with publication authority and system audit rights.

---

### Controller Digital E-Signature Seal
Every official University Hall Ticket and verified Answer Booklet dynamically requires the signature of the **Controller of Examinations**.
1. In `/admin`, scroll to **Controller of Examinations E-Signature**.
2. Notice the current high-resolution institutional signature seal.
3. To update:
   - **Upload:** Select a transparent PNG scan of the Controller's official signature.
   - **Draw:** Use the touch/pen canvas pad to draw a live signature.
   - Click **Save Signature**.
4. **Security Invariant:** Saving an updated Controller signature automatically purges any cached document PDFs from the immutable storage table (`stored_documents`), ensuring regenerated PDFs immediately bind the new signature and SHA-256 digest.

---

### ERP (UOS) Integration & Roster Sync
1. Navigate to the **ERP & Integration** tab.
2. View the active connection to the University ERP (`uos`).
3. View the generated **ERP API Key** (e.g. `exk_live_...`).
4. Click **Trigger Roster Sync** to ingest newly matriculated students, program enrollments, or department transfers from the central student database.

---

### Outbox Email & Webhook Delivery Health
ExamOS uses a guaranteed **Transactional Outbox Pattern**:
1. Check the **Outbox Notification Dispatcher** section.
2. Notice two distinct lanes:
   - `TRANSACTIONAL`: High-priority real-time alerts (Account Activation, Suspension Alerts, Integrity Hold Notices).
   - `BULK`: Batch announcements (Hall Ticket Release, Exam Day Instructions, Result Publication).
3. The table displays delivery status (`ACCEPTED`, `QUEUED`, `BOUNCED`), recipient addresses, and provider message IDs.

---

### Cryptographic Audit Log & Timeline
1. Scroll to the **Tamper-Evident Audit Ledger**.
2. Every administrative operation (role changes, policy waivers, publication grants, paper modifications) writes an append-only row containing:
   - `actor_type` & `actor_id`
   - `action` (e.g. `exam.published`, `candidate.held`)
   - `prev_hash` & `current_hash` (cryptographic SHA-256 chain)
   - Canonical metadata payload.

---

## 3. Role Manual 2: Examination Cell Operator

**Persona:** `examcell@demo.local` (`Demo-Staff!2026`)  
**Portal Route:** `/examcell`

### Overview & Duties
The Examination Cell Operator creates examination schedules, authors multi-section question papers with itemized rubrics, configures Safe Exam Browser (SEB) lockouts, generates student allocations and hall tickets, monitors the Precheck Readiness Board, conducts live exam sessions, and reviews evaluated candidate packets.

---

### Creating Examinations & Security Profiles
1. Log in as `examcell@demo.local`.
2. Navigate to **Exams** -> Click **New Examination**.
3. Fill in the examination parameters:
   - **Course Code & Title:** e.g., `CS302` — Database Systems.
   - **Exam Type:** `SEM_EXTERNAL`, `MID_1`, or `MID_2`.
   - **Max Marks & Duration:** e.g., 70 marks, 180 minutes.
   - **Security Profile:**
     - `BASIC_BROWSER`: Standard web environment with tab focus tracking, full-screen lockdown heuristics, and devtools monitoring.
     - `SECURE_BYOD`: Safe Exam Browser enforcement (requires generated `.seb` configuration, blocks virtual machines, disables screen capture, locks clipboard).
4. Click **Create Examination** (Exam starts in `DRAFT` state).

---

### Setting Multi-Section Question Papers & Rubrics
1. Select the draft exam -> Open the **Question Paper** tab.
2. Click **Add Section** (e.g., *Section A: Relational Concepts*, *Section B: Storage & Transactions*).
3. For each question:
   - Set Question Number, Type (`DESCRIPTIVE`), and Maximum Marks.
   - Enter Question Prompt (supports full Markdown and LaTeX KaTeX math equations).
   - **Configure Rubric Criteria:**
     - Criteria Code (e.g., `BCNF_DEF`)
     - Max Marks (e.g., 8 marks)
     - Description for Evaluator (e.g., *"Accurate distinction between 3NF and BCNF with functional dependencies"*).
4. Click **Save Paper Draft**.
5. When finished, click **Submit Paper for Review** (Paper transitions to `REVIEW`).

---

### Safe Exam Browser (SEB) XML Generation
For exams configured with `SECURE_BYOD`:
1. Open the exam -> Navigate to the **Client Security & SEB** tab.
2. Configure lockouts:
   - **Quit Password:** Set an emergency proctor exit password.
   - **Kiosk Mode:** Enable full OS lockdown.
   - **Block Virtual Machines:** Prevent exam running inside VirtualBox/VMware.
   - **Prohibit Processes:** Auto-close communication tools (Discord, Teams, Slack).
3. Click **Generate SEB Configuration**.
4. The system calculates the cryptographic `X-SEB-ConfigKey` hash and embeds it into the exam policy. Staff can immediately click **Download .seb File** to inspect the Apple plist XML.

---

### Cohort Allocations & Dynamic Dual-Signature Hall Tickets
1. Go to the **Candidates** tab.
2. Click **Allocate Students** -> Select Cohort (e.g., *B.Tech CSE Semester 5*).
3. Click **Issue Hall Tickets**.
4. **Dynamic Dual Signature Invariant:**
   - Hall ticket records are minted with a verifiable cryptographic hash.
   - The ticket embeds the student's candidate e-signature and the University Controller's official seal.
   - Click **Download Hall Ticket (PDF)** on any candidate card to preview or print the official PDF.

---

### Precheck Readiness Board & Controller Waivers
1. Once an exam is in `PRECHECK` status (typically opened 15–30 minutes before exam start):
2. Open the **Readiness Board** tab.
3. Review the live status distribution across 4 summary chips:
   - **Ready:** Students who passed all 7 readiness preflight checks.
   - **In Progress:** Students currently executing the verification steps.
   - **Blocked / Remediate:** Students failing hardware, dual-monitor, or client version checks.
   - **Not Started:** Students who have not yet initiated prechecks.
4. **Granting Admission Exceptions (Controller/Exam Cell):**
   - Click on a blocked candidate (e.g., Student 09 blocked by dual monitor detection).
   - Click **Grant Admission Exception**.
   - Select reason code (e.g., `TECH_ALT_DEVICE`).
   - Enter justification: *"Invigilator verified secondary monitor disconnected at campus desk 12"*.
   - Click **Authorize Exception**.
   - The student is allowed to retry and finalize precheck to achieve `READY` status.

---

### Examination Lifecycle Transitions
Under the **Actions** menu, progress the exam through its strict state machine:
1. `DRAFT` -> Click **Submit for Review**.
2. (Chief Reviewer approves paper) -> Click **Schedule Exam**.
3. (Exam day arrives) -> Click **Open Precheck** (Status becomes `PRECHECK`).
4. (Window opens) -> Click **Start Examination** (Status becomes `LIVE`).
5. (Window ends) -> Click **Close Examination** (Status becomes `CLOSED`, sealing all candidate attempts).

---

### Managing Candidate Integrity Holds & Approvals
Once an exam is `CLOSED`:
1. System runs automated forensic checks on all submissions (verifying cryptographic manifests, hash trees, and revision history).
2. Once the Examiner submits marks, open the **Candidate Approvals** tab.
3. Inspect each candidate review packet:
   - Verified submission seal.
   - Total marks vs question criteria marks sum recomputation.
   - Proctor incident history.
4. **Placing an Integrity Hold:**
   - If an invigilator reported desk irregularities, click **Place on Hold**.
   - Select `INTEGRITY_HOLD`.
   - Enter reason for committee review.
   - The candidate's packet is frozen, preventing publication until formally cleared.
5. **Approving Results:**
   - For compliant candidates, click **Approve Candidate Review Packet**.
   - The packet transitions to `CANDIDATE_APPROVED`, awaiting final Controller publication authorization.

---

### Revaluation Applications Processing
1. Navigate to **Revaluations** in the Exam Cell console.
2. View pending requests submitted by students (e.g., Student 02 on `CS305-PUB`).
3. Review the candidate's stated justification and payment fee receipt reference.
4. Click **Route to Re-Evaluation** to re-queue the candidate paper for independent double-blind evaluation.

---

## 4. Role Manual 3: Chief Reviewer & Chief Proctor

**Persona:** `chief@demo.local` (`Demo-Staff!2026`)  
**Portal Route:** `/proctor` & `/examcell`

### Overview & Duties
The Chief Reviewer acts in a dual capacity:
1. Prior to exam conduct, they perform blind peer-review of question papers, vetting syllabus alignment and mark distributions.
2. During live exams, they command the **Chief Proctoring Desk**, reviewing real-time violation signals, confirming warnings, enforcing suspension thresholds, and issuing authorized resumes with deadline extensions.

---

### Question Paper Review & Approval
1. Log in as `chief@demo.local`.
2. Navigate to **Exams** -> Open `CS302-SEM` (or any paper in `PAPER_REVIEW`).
3. Click the **Question Paper** tab.
4. Carefully inspect each section, descriptive question prompt, and rubric scoring guide.
5. Click **Approve Question Paper** (or **Reject with Revision Notes** if syllabus adjustments are required).

---

### Live Proctoring Console
1. Navigate to `/proctor`.
2. Select an active live examination (e.g., **`CS303-LIVE` — Computer Networks**).
3. The dashboard displays:
   - **Active Candidates:** Real-time pulse and device heartbeats.
   - **Incidents Feed:** Streaming timeline of client-reported and server-detected anomalies.
   - **Warning Distribution:** Candidates with 1, 2, 3, 4, or 5 warnings.

---

### Incident Signals, Confirmations & Dismissals
ExamOS follows the strict core invariant: **"Humans decide — no proctoring signal becomes a countable warning without a named human's decision."**

```
Client Signal / Server Observation
  │
  ├─► FOCUS_LOST (Student switched windows)
  ├─► FULLSCREEN_EXIT (Window un-maximized)
  └─► CONCURRENT_SESSION (Rogue device login)
        │
        ▼
   Proctor Incident Queue (Under Review)
        │
        ├─────────────────────────────┐
        ▼                             ▼
   DISMISS                       CONFIRM WARNING
 (False positive /             (Select Reason Code &
  peripheral glitch)            add invigilator notes)
        │                             │
        ▼                             ▼
  Incident Cleared              Countable Warning Added
                                (Suspension if Nth warning)
```

1. Click on an incident in the feed (e.g., Student 02: `FOCUS_LOST` for 4.5s).
2. Review telemetry: duration, window focus event timestamps, IP address history.
3. Choose Action:
   - **Dismiss:** For innocent system notifications or momentary mouse drifts.
   - **Confirm Warning:** Select reason code (e.g., `POLICY_VIOLATION_REVIEWED`), enter explanatory notes (e.g., *"Candidate switched tabs to external browser"*), and click **Confirm Warning**.
4. The warning is logged in the append-only `proctor_warnings` ledger and delivered immediately to the candidate's workspace.

---

### Warning Threshold Suspension
- If a candidate accumulates **5 confirmed warnings** within an active epoch:
- The server **automatically suspends the attempt inside the same transaction**.
- The candidate's workspace is locked with a red **Attempt Suspended** barrier.
- Autosaves are blocked, and an outbox alert email is enqueued to the student and Chief Proctor.

---

### Authorized Resume & Deadline Extensions
1. In `/proctor`, locate the suspended student (e.g., Student 04).
2. Interview the candidate or review invigilator lab reports.
3. Click **Resume Candidate Attempt**.
4. Fill out the Resume Grant modal:
   - **Reason Code:** e.g., `REVIEWED`.
   - **Official Notes:** *"Peripheral glitch resolved; desk cleared of unauthorized devices; 5-minute compensatory extension approved"*.
   - **Deadline Extension:** Enter `5` (minutes).
5. Click **Authorize Resume**.
6. **Cryptographic Impact:**
   - The current warning epoch is sealed.
   - A new epoch (`epoch_no + 1`) is opened with a reset warning counter.
   - The candidate's `authorization_generation` is bumped.
   - The server pushes a new deadline timestamp (`deadline_at + 5 minutes`).
   - The student's workspace unlocks instantly.

---

## 5. Role Manual 4: Examiner, Evaluator & Moderator

**Persona:** `evaluator@demo.local` (`Demo-Staff!2026`)  
**Portal Route:** `/evaluator`

### Overview & Duties
Examiners grade candidate answers submitted for completed exams. ExamOS supports **Double-Blind Evaluation**, rendering student text answers, LaTeX math equations, and vector canvas diagrams side-by-side with rubric criteria.

---

### Double-Blind Evaluation Queue
1. Log in as `evaluator@demo.local`.
2. Navigate to `/evaluator`.
3. Select an evaluated exam (e.g., **`CS304-EVAL` — Design & Analysis of Algorithms**).
4. View the candidate queue:
   - Students are masked with anonymous evaluation IDs to preserve unbiased marking.
   - Shows status (`AWAITING_MARKS`, `MARKED`, `MODERATION_REQUIRED`).
5. Click **Evaluate Candidate Paper** on any row.

---

### Evaluating Answers, LaTeX Formulas & Vector Canvas
1. The evaluation workspace splits into two synchronized panels:
   - **Left Panel (Question & Prompt):** Displays the official question prompt, expected answer guidelines, and maximum marks.
   - **Right Panel (Candidate Submission):** Displays the candidate's exact final revision:
     - Formatted paragraphs.
     - Rendered KaTeX mathematical formulas (e.g., $\mathcal{O}((V + E) \log V)$).
     - Interactive Vector Canvas diagrams (zoomable pen, line, and shape drawings created during the exam).

---

### Criteria Rubric Scoring & Justifications
1. Below each question submission, review the itemized rubric breakdown:
   - Criterion 1: `CASES` (Max: 4 marks) -> Award points (e.g. `4`).
   - Criterion 2: `SOLVE` (Max: 4 marks) -> Award points (e.g. `4`).
2. Enter the **Examiner Explanation & Constructive Feedback**:
   - e.g., *"Perfect Master Theorem calculation; all three recurrence cases clearly distinguished."*
3. The system automatically recalculates the question total and overall paper sum.
4. Click **Submit Result Version**.
5. The result version is committed with a cryptographic SHA-256 digest, signed with the examiner's user ID, and locked against tampering.

---

### Moderation Divergence Detection
- If multiple examiners evaluate the same candidate paper and their total marks diverge by more than the institution's threshold (e.g., > 10% variance):
- The packet automatically transitions to `MARKING_MODERATION_REQUIRED`.
- The Chief Moderator opens the comparison view to reconcile rubric item differences before final submission to the Exam Cell.

---

## 6. Role Manual 5: Student / Candidate

**Persona:** `student01@demo.local` .. `student12@demo.local` (`Demo-Student!2026`)  
**Portal Route:** `/student`

### Overview & Candidate Portal
Students use ExamOS as a seamless, high-integrity digital exam portal. From identity verification to taking exams and accessing lifelong academic records:

```
                                  Student Portal
                                ┌─────────────────┐
                                │ student01@demo  │
                                └────────┬────────┘
                                         │
     ┌───────────────────┬───────────────┴───────────────┬───────────────────┐
     ▼                   ▼                               ▼                   ▼
┌──────────────┐  ┌──────────────┐               ┌──────────────┐    ┌──────────────┐
│ Profile & ID │  │ Hall Ticket  │               │  Prechecks   │    │ Live Workspace│
│ Photo / Sign │  │ Dynamic PDF  │               │ 7-Step Check │    │ Autosave / OT│
└──────────────┘  └──────────────┘               └──────────────┘    └──────────────┘
                                                                             │
                                                                             ▼
                                                                     ┌──────────────┐
                                                                     │Lifelong Ledger│
                                                                     │Booklets & Rev│
                                                                     └──────────────┘
```

---

### Student Profile, Photo Upload & ID Card QR
1. Log in as `student01@demo.local` (Aarav Sharma).
2. Click **Profile & ID** in the top navigation bar.
3. Review registered academic information:
   - **Register Number:** `22CSE001`
   - **Department:** Computer Science & Engineering
   - **Programme:** B.Tech CSE (Semester 5)
4. **Photo Upload:**
   - Click **Upload Photo**.
   - Select a passport photo (PNG or JPEG).
   - Check the **Consent Declaration** checkbox.
   - Click **Save Photo**.
5. **Digital Student ID Card:**
   - Scroll to **Institutional Identity Card**.
   - Notice the high-contrast University ID badge featuring the student's photo, enrollment number, and a secure dynamic QR code.
   - Security guards or invigilators can scan this QR code with any camera phone to verify the student's enrolled authenticity against `/student/verify-student/:hash`.

---

### Candidate Digital E-Signature
1. On the **Profile & ID** page, scroll to **Candidate Signature**.
2. Click **Update Signature**.
3. Choose either:
   - **Upload File:** Select a clear scan of your signature.
   - **Draw Signature:** Use mouse or touch screen to draw your signature directly on the canvas.
4. Click **Save E-Signature**.

---

### Official Hall Ticket PDF Download
1. On `/student/profile`, scroll to **Active Hall Tickets**.
2. Click **Download Official PDF** on any scheduled exam (e.g., `CS302-SEM` or `CS301-MID1`).
3. Notice that the generated PDF contains:
   - University Header, watermark, and candidate registration details.
   - The dynamic **Candidate Signature** (left block).
   - The dynamic **Controller of Examinations Institutional Seal** (right block).
   - An anti-counterfeiting verification QR code.

---

### Safe Exam Browser (.seb) Configuration Download
For exams flagged with `SECURE_BYOD`:
1. Navigate to the exam card on the student home screen.
2. Click **Download SEB Configuration (.seb)**.
3. Double-click the downloaded `.seb` file on Windows or macOS to launch Safe Exam Browser directly in kiosk mode with pre-configured network certificates and exit keys.

---

### 15-Minute Readiness Precheck Sequence
When an exam is in `PRECHECK` status (e.g., **`CS301-MID1`**):
1. On the student dashboard, click **Enter Readiness Check**.
2. The interactive 7-step sequence guides the student:
   - **Step 1: Client Version Verification** — Confirms secure client build.
   - **Step 2: Clock Synchronization** — Server checks system time drift (< 2000ms allowable).
   - **Step 3: Keyboard Input Test** — Live typing sample validates keypress handlers.
   - **Step 4: System Hardware Scan** — Validates single display, battery status, and OS integrity.
   - **Step 5: Network Roundtrip Test** — Simulates an encrypted test autosave payload.
   - **Step 6: Academic Honor Code Consent** — Candidate accepts academic regulations.
   - **Step 7: Finalize Readiness** — Issues a green **READY** verification badge.

---

### Live Exam Workspace (OT Typing & Math Whiteboard)
When the exam starts (`LIVE` phase, e.g., **`CS303-LIVE`**):
1. Click **Enter Examination**.
2. The system requests a one-time entry grant and admits the candidate session.
3. **Workspace Features:**
   - **Top Navigation Bar:** Live countdown timer synchronized with server time, connection heartbeat indicator, and quick-jump Question Map.
   - **Operational Transform (OT) Autosave:** Every character typed is immediately dispatched as an atomic operation with a client operation ID and base revision, acknowledged with a green save indicator.
   - **Math Formulas & KaTeX:** Click **Insert Formula** to insert inline KaTeX equations ($\int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}$).
   - **Interactive Vector Whiteboard:**
     - Toggle between Text and Drawing canvas for any descriptive question.
     - Use pen, brush width, colors, eraser, and geometric shape tools to draw architecture diagrams, circuit diagrams, or algorithmic flowcharts.
     - Canvas strokes are serialized as structured vector JSON and saved alongside paragraphs.
   - **Resilience:** Even if the network drops entirely, local drafts are preserved in encrypted session storage, and the workspace automatically reconnects and rebases without data loss once signal restores.
4. When finished, click **Submit Examination**. The server generates an immutable cryptographic receipt and seals the attempt.

---

### Lifelong Academic Ledger & Graded Answer Booklets
For published exams (e.g., **`CS305-PUB`**):
1. On `/student`, click **Academic Ledger**.
2. View your cumulative GPA, earned credits, and verified letter grades (`O`, `A+`, `B+`, etc.).
3. Click **View Graded Answer Booklet**:
   - Displays the candidate's exact submitted answers alongside examiner marks and rubrics.
   - Download the official booklet as an archival PDF with watermarks and verification stamps.

---

### Submitting a Revaluation Request
1. In the Answer Booklet view, click **Request Revaluation**.
2. Fill out the application:
   - **Questions Disputed:** Select questions (e.g., Question 2).
   - **Justification:** State academic grounds (e.g., *"Detailed architectural diagrams for Saga pattern and CQRS were submitted; requesting re-examination of rubric criteria scores"*).
   - **University Fee Receipt Reference:** Enter bank or ERP transaction code (e.g., `FEE-UOS-2026-REV-001`).
3. Click **Submit Revaluation Application**. The Exam Cell receives the request immediately in their revaluation console.

---

## 7. The "Full Show" Master Walkthrough

Follow this scripted 12-act chronological rehearsal to demonstrate the entire platform end-to-end to stakeholders, auditors, or students:

```
[Act 1: Admin Setup] ──► [Act 2: Paper Authoring] ──► [Act 3: Chief Review]
         │
         ▼
[Act 4: Allocations] ──► [Act 5: Student Tickets] ──► [Act 6: Readiness Board]
         │
         ▼
[Act 7: Exception]   ──► [Act 8: Live Answering]  ──► [Act 9: Proctor Suspension]
         │
         ▼
[Act 10: Submission] ──► [Act 11: Evaluation]     ──► [Act 12: Publication & Rev]
```

### Chronological 12-Act Rehearsal Script

| Act | Persona / Login | Screen / Action | What to Observe / Demonstrate |
| :---: | :--- | :--- | :--- |
| **1** | `admin@demo.local` | `/admin` | View 4/4 staff seats limit; preview Controller signature seal; verify ERP UOS sync status and outbox delivery. |
| **2** | `examcell@demo.local` | `/examcell` -> `CS302-SEM` | View draft paper; show multi-section descriptive questions, Markdown prompts, and rubric criteria; inspect SEB policy. |
| **3** | `chief@demo.local` | `/examcell` -> `CS302-SEM` | Switch to Chief Reviewer persona; approve question paper; observe paper status lock and immutable version stamping. |
| **4** | `examcell@demo.local` | `/examcell` -> `CS302-SEM` | Generate Question Paper Sets (A & B); allocate student cohort; issue hall tickets with dual dynamic signatures. |
| **5** | `student01@demo.local` | `/student/profile` | View Student Profile; show verified photo; download official Hall Ticket PDF and show Controller seal + Candidate signature. |
| **6** | `examcell@demo.local` | `/examcell` -> `CS301-MID1` | Open Precheck; open Readiness Board; show distribution chips (Ready: 7, In-Progress: 2, Blocked: 1, Remediate: 1). |
| **7** | `examcell@demo.local` | `/examcell` -> `CS301-MID1` | Click blocked Student 09; grant admission exception (`TECH_ALT_DEVICE`); watch student retry and turn green `READY`. |
| **8** | `student01@demo.local` | `/student` -> `CS303-LIVE` | Enter live exam; demonstrate real-time autosave typing, KaTeX math formula rendering, and vector drawing canvas. |
| **9** | `chief@demo.local` | `/proctor` -> `CS303-LIVE` | View live incident queue; confirm warning for Student 02; show Student 04 suspended on 5th warning; resume with +5m extension. |
| **10** | `student01@demo.local` | `/student` -> `CS303-LIVE` | Submit exam; show cryptographic receipt; Exam Cell closes exam; show automated forensics pass across all attempts. |
| **11** | `evaluator@demo.local` | `/evaluator` -> `CS304-EVAL` | Open double-blind marking queue; evaluate candidate paper; grade by criteria rubrics; Exam Cell places hold on anomalous candidate. |
| **12** | `student01@demo.local` | `/student` -> `CS305-PUB` | Open Academic Ledger; show published grade `O` (46/50); download verified Answer Booklet PDF; submit revaluation for Student 02. |

---

## 8. System Architecture & Security Invariants

ExamOS is architected around foundational security guarantees designed for high-stakes university accreditation:

### Zero-Security-Shortcut Guarantee
1. **Unverifiable Client Claims:** Checks that cannot be cryptographically measured on the server are logged as `UNVERIFIABLE`, never `PASS`. Client device timestamps, client-reported marks, and local state are never authoritative.
2. **Double-Blind Integrity:** Student names and registration numbers are stripped from examiner evaluation queues to eliminate grading bias.
3. **Immutable Revisions:** All answer edits are stored as append-only operational transform delta rows in `answer_revisions`. Overwrites are forbidden.

### Database Row-Level Security (`withTenantTx`)
Every query across tenant tables executes within a PostgreSQL transaction bound to the caller's tenant identifier:
```sql
SET LOCAL app.tenant_id = 'tenant-uuid';
```
PostgreSQL Row-Level Security (RLS) policies automatically block cross-tenant data leakage even in multi-campus deployments.

### Append-Only Audit & Forensic Trails
All critical lifecycle tables are append-only:
- `audit_events`: SHA-256 chained transaction trail.
- `proctor_warnings`: Human-confirmed warnings bound to warning epochs.
- `attempt_event_log`: Second-by-second candidate heartbeat and event timeline.
- `submission_manifests`: Cryptographic hash tree sealing every question's final revision.
- `controller_publication_grants`: Controller publication authorizations bound to verified result versions.

---

*St. Mary's University Examination Operating System — SMRU ExamOS 2026*
