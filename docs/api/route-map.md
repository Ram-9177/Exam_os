# ExamOS API route map (all JSON; errors are RFC7807 problem objects with `code`)

Base: `/api/v1`. Tenant is resolved from the request Host header (dev: `localhost` must be registered as a tenant domain; use Vite proxy with `changeOrigin: false` and `headers: { Host: '<tenant-host>' }`, or run the API with the tenant host mapped in /etc/hosts).
Auth: `Authorization: Bearer <accessToken>` (10-min RS256 JWT); refresh with `POST /auth/refresh {refreshToken}`; 401 with code `TOKEN_INVALID` → refresh once then retry; `SESSION_REVOKED` → logout.
Student exam requests after admission MUST send header `x-device-session: <deviceSessionId returned by admit/reconnect>`.

Outside `/api/v1` (path is absolute):
GET  /healthz → {ok:true} | 503 {ok:false,error} (database + Redis liveness probe)

## Public (host tenant)
GET  /tenant → {id, slug, name, timezone, ssoProvider}
POST /auth/login {email,password} → {accessToken, refreshToken, expiresIn, user:{id,email,fullName,kind}}
POST /auth/refresh {refreshToken} → same shape
POST /auth/activate {token,password} → same shape (token comes from the activation e-mail link ?token=)
POST /auth/logout (auth) → 204
GET  /auth/me (auth) → {userId,email,kind,grants:[{role,scopeType,scopeId}],tenant}
GET  /auth/oidc/start?redirectUri= → {authorizationUrl,state}
POST /auth/oidc/callback {code,state} → token pair (no auto-provisioning: the SSO identity must match an existing account)
GET  /auth/.well-known/jwks.json → {keys:[…]} public RS256 verification keys
GET  /student/verify/:attemptId/:version → {valid,published,version,publishedAt,total,max}   (public result verification page)

## Student (role STUDENT; permission attempts:own)
GET  /student/me/exams → {exams:[{examId,code,title,examType,academicYear,semester,examStatus,securityProfile,durationMinutes,windowStartAt,windowEndAt,courseCode,courseName,extraTimeMinutes,attemptId,attemptStatus,deadlineAt,hallTicketNumber,hallTicketVerification}]}
GET  /student/me/exams/:examId/hall-ticket.pdf → PDF binary with verification QR (embedded signed hash)
GET  /student/me/ledger → {records:[{exam_type,academic_year,semester,marks,max_marks,grade,hall_ticket_number,published_at,examCode,examTitle,courseCode,courseName}], semesters:[{academic_year,semester,exams,marks,max_marks,percentage}], overall:{exams,semesters,marks,max_marks,percentage}}
GET  /student/attempts/:id/paper (student own, exam LIVE) → {paper:{paper_id,title,total_marks,sections,setCode},questions:[{question_id,section_id,question_number,kind,prompt,max_marks,options}]} (expected_answer and rubric stripped)
POST /student/attempts/:attemptId/prechecks {clientBuild} → 201 {runId, checks:[{code,status,source,diagnosticCode,remediationCode,instruction,optional}]}   (409 PRECHECK_NOT_OPEN until Exam Section opens it)
POST /student/prechecks/:runId/items/verify {code, clientBuild?, clientClockMs?, keyboardSample?, canvasOps?, consentPolicyVersion?, scan?} → {checks:[...]}
     codes: CLIENT_VERSION, CLOCK_SYNC(clientClockMs=Date.now()), KEYBOARD_INPUT(keyboardSample≥20 chars with letters, digits, punctuation), CANVAS_INPUT(canvasOps count; OPTIONAL — stylus optional), NETWORK_SAVE_ROUNDTRIP(after a practice save), CONSENT(consentPolicyVersion = policyVersion from GET /student/attempts/:id/policy), CAMERA, MICROPHONE (client-declared; high-tier profiles show UNVERIFIABLE honestly until the media pipeline exists), SYSTEM_SCAN(scan = raw DeviceScan; the server derives findings, appends a device_scans row and records the item as CLIENT_DECLARED — a BLOCKING finding is REMEDIATE/FIX_DEVICE_SETTINGS, a clean scan is never a security PASS)
GET  /student/attempts/:attemptId/policy → {attemptId,attemptStatus,examId,examTitle,examStatus,securityProfile,policyVersion,durationMinutes,windowStartAt,windowEndAt,consentPurposes,checks:[{code,mandatory,serverMeasured,optional,securityRelevant}],allowedClientBuilds,cameraPresence,monitoringNotice}   (cameraPresence: the workspace runs the on-device face-presence check; CAMERA consent then required)
     IDENTITY_SESSION and ELIGIBILITY are server-measured (400 if submitted)
POST /student/prechecks/:runId/practice-saves {contentDigest: sha256 hex} → {revision, ackAt}
POST /student/prechecks/:runId/finalize → {precheckId,status:'READY'|'REMEDIATE'|'REVIEW',securityProfile,checks:[{...,mandatory,coveredByException,securityRelevant}],examTimerStarted:false,readyUntil,helpAction}
POST /student/attempts/:attemptId/entry-grants → 201 {grantToken, expiresAt}   (409 EXAM_NOT_STARTED = lobby: "waiting for the Examination Section to start"; 409 NOT_READY; PRECHECK_STALE); 403 SECURE_CLIENT_REQUIRED for a Safe Exam Browser exam without a valid SEB key (recorded as SECURE_CLIENT_MISSING first). The same gate applies to /admit (grant not consumed) and /reconnect; /heartbeat only flags a missing key
POST /student/attempts/:attemptId/admit {grantToken} → {attemptId,status:'ACTIVE',serverNow,deadlineAt,authorizationGeneration,warningEpochId,deviceSessionId}
POST /student/attempts/:attemptId/code-runs {questionId,language (catalogue id),source,files?:{path:content}} (own ACTIVE attempt, x-device-session) → {runId,remaining,error,results:[{test,passed,verdict,output,expected,compileOutput?}]}   (project questions: only the editable files count, the setter's other files and build/run commands are used; 422 NOTHING_TO_RUN, 422 LANGUAGE_NOT_ALLOWED)   (runs a CODE question's visible sample tests only, in the isolated judge; 429 SAMPLE_RUNS_EXHAUSTED past the question's limit; 503 JUDGE_UNAVAILABLE without JUDGE_URL; hidden tests run only after sealing)
PUT  /student/attempts/:attemptId/answers/:questionId {clientOperationId(uuid), baseRevision, answerFormat:'hybrid-v1', ops:[{op:'upsert-block'|'delete-block'|'reorder', blockId, kind?:'paragraph'|'equation'|'table'|'canvas'|'choice', content?, after?}], contentSha256} → {accepted,serverRevision,receiptId,serverSavedAt,contentSha256,duplicate}
     Every upserted block is validated by kind before anything is written: paragraph = text ≤ 50,000 chars; canvas = CanvasContentSchema (≤ 3,000 items / 120,000 points, coordinates inside the canvas); choice = {selected}; a document holds ≤ 200 blocks / 4 MB canonical. Refusals: 422 ANSWER_INVALID / ANSWER_TOO_LARGE (the client keeps the draft and waits for the student's next edit); 409 DEADLINE_PASSED from the attempt's own deadline (the server seals such attempts as EXPIRED ≈30 s later and the heartbeat returns the receipt); 503 DB_BUSY (retryable) when the database is saturated.
     409 REVISION_CONFLICT (refetch GET answer and rebase), 422 CONTENT_HASH_MISMATCH, 409 ATTEMPT_NOT_ACTIVE, 409 DEVICE_SESSION_MISMATCH, 409 DEADLINE_PASSED
     contentSha256 = SHA-256 hex of canonical JSON (keys sorted recursively, no whitespace) of {blocks:[{id,kind,content}]} AFTER applying ops in order. Block order matters. upsert appends new blocks at end; reorder moves block after `after` (null = first).
GET  /student/attempts/:attemptId/answers/:questionId → {questionId, serverRevision, content:{blocks}, contentSha256}
POST /student/attempts/:attemptId/heartbeat (every 20s; 30/min per student) → {status, serverNow, deadlineAt, authorizationGeneration, receipt:{receiptId,manifestSha256,sealedAt}|null}   (receipt present once the attempt is sealed — submitted, expired by its own deadline, or voided)
POST /student/attempts/:attemptId/device-scans {scan: DeviceScan} (attempt ACTIVE/RECOVERY_PENDING/SUSPENDED; every 60 s from the workspace) → 202 {scanId, verdict:'CLEAN'|'REVIEW'|'BLOCKED', findings:[DeviceScanFinding]}   (append-only device_scans row; BLOCKING findings raise the mapped proctor signal — DUAL_SCREEN_DETECTED, AUTOMATION_DETECTED, VIRTUAL_MACHINE_DETECTED, SCREEN_CAPTURE_ATTEMPT — for human review; never a warning, never a pause; 400 if the client sends a verdict instead of a scan)
     Network: every readiness/admission/in-exam request (prechecks, admit, heartbeat, answers PUT, reconnect, submit, proctor/events, SYSTEM_SCAN verify) upserts attempt_network_observations(attempt_id, ip) and admission stores admitted_ip. Exam policy ipPolicy: LOG (default; attempt_event_log network.address_changed) · REVIEW (also a NETWORK_ADDRESS_CHANGED signal for a human) · LOCK (in-exam requests from another address → 409 NETWORK_ADDRESS_LOCKED after the observation, event and signal commit on their own; a proctor resume with rebindDevice clears admitted_ip and the next reconnect re-binds it). requireManagedEndpoint + allowedSubnets → 409 NETWORK_NOT_ALLOWED outside the lab network, recorded the same way.
POST /student/attempts/:attemptId/reconnect → {status:'ACTIVE', deadlineAt, deviceSessionId, serverNow, answers:[{questionId,serverRevision,contentSha256}]}
POST /student/attempts/:attemptId/submit {idempotencyKey(uuid)} → {receiptId, manifestSha256, sealedAt, manifest}
GET  /student/attempts/:attemptId/booklet (student own after publication; staff by permission marks:approve | examcell:candidates:read | attempts:read, never while the exam is PRECHECK/LIVE → 403 EXPORT_LOCKED, recorded) → {tenant,exam,student:{name,registerNumber,hallTicket},status,sealedAt,manifestSha256,questions:[{questionId,answer:{blocks},answerSha256,revision,marks,maxMarks,explanation,criteria}],total:{marks,max,version},validation:{examiner,examinerApprovedAt,controller,publishedAt},verificationHash,verificationUrl}
GET  /student/attempts/:attemptId/booklet.pdf → PDF binary with vector diagram rendering and verification QR (409 NOT_PUBLISHED prior to publication)
POST /proctor/events {events:[{sourceEventId,attemptId,signalClass,clientRecordedAt?,clientSequence?,metadata ≤ 2 KB}]} → 202 (the student's own client: FOCUS_LOST, FULLSCREEN_EXIT, DISPLAY_CHANGED, DUAL_SCREEN_DETECTED, MULTIPLE_TABS, WINDOW_RESIZED, CLIPBOARD_ATTEMPT, SCREEN_CAPTURE_ATTEMPT, DEVTOOLS_ATTEMPT, FACE_NOT_VISIBLE, MULTIPLE_PERSON_POSSIBLE, CAMERA_UNAVAILABLE…); 403 SERVER_ONLY_SIGNAL for CONCURRENT_SESSION, NETWORK_ADDRESS_CHANGED, SECURE_CLIENT_MISSING

## Exam Section / Controller (EXAM_CELL_OPERATOR, CONTROLLER)
GET  /exams?status&examType&academicYear&semester&departmentCode&schoolCode&q → {exams:[{id,code,title,status,examType,academicYear,semester,securityProfile,durationMinutes,windowStartAt,windowEndAt,courseCode,courseName,departmentCode,departmentName,schoolCode,schoolName}]}
POST /exams {code,title,courseCode,examType,academicYear,semester,maxMarks,securityProfile,durationMinutes,windowStartAt,windowEndAt,warningThreshold,policy} → 201 {examId}
GET  /exams/:id → {exam, attemptCounts}
POST /exams/:id/submit-for-review (exams:write) → {from,to:'PAPER_REVIEW'}
POST /exams/:id/approve (exams:write) → {from,to:'APPROVED'}
POST /exams/:id/schedule (exams:write) → {from,to:'SCHEDULED'}
POST /exams/:id/open-precheck (exams:conduct) → {from,to:'PRECHECK'}
POST /exams/:id/start (exams:conduct) → {from,to:'LIVE'}
POST /exams/:id/close (exams:conduct) → {from,to:'CLOSED',sealing:{sealed,pending}}   (every open attempt's deadline becomes now in one statement, then attempts are sealed one transaction each — inline up to 200 / 8 s, the rest by the worker's seal-closed-exams loop within seconds; a per-attempt deadline-sweep loop seals students whose own time ran out while the exam stays LIVE)
POST /exams/:id/archive (exams:write) → {from,to:'ARCHIVED'}
POST /exams/:id/cancel (exams:write) → {from,to:'CANCELLED'}
     All eight are bodiless state-machine transitions checked by assertTransition (409 ILLEGAL_TRANSITION otherwise).
POST /exams/:id/allocations {studentExternalIds:[], provider:'uos', extraTimeMinutes} → {allocated, skipped:[{externalId,reason}]}
POST /exams/:id/hall-tickets {} → {issued}
GET  /exams/:id/hall-tickets/:userId/pdf → PDF binary (exams:read)
GET  /exams/:id/readiness → {exam:{id,code,title,status,securityProfile,startedAt,precheckOpenedAt}, summary:{total,ready,needsFix,needsReview,notStarted,active,suspended,submitted}, candidates:[{attemptId,status,suspensionKind,fullName,email,registerNumber,hallTicket,precheck:{runId,status,clientBuild,startedAt,readyUntil}|null,checks:[{code,status,source,diagnosticCode,remediationCode,instruction,securityRelevant}],blocking:[codes],exceptions:[{id,code,coversChecks,approvedBy,expiresAt}]}]}
POST /exams/:id/attempts/:attemptId/admission-exceptions {exceptionCode:'ACC_APPROVED'|'TECH_ALT_DEVICE'|'PROCTOR_OVERRIDE'|'POLICY_INCOMPATIBILITY', coversChecks:[codes], reason, expiresInMinutes} → 201 (403 SECURITY_OVERRIDE_REQUIRED unless Controller)
GET  /exams/:id/candidates → {summary:{total,ready,approved,published,needsReview,onHold,awaitingMarks}, candidates:[{id,attempt_id,status,version,result_version_id,academic_state,identity_state,integrity_state,media_quality_state,hold_reason,fullName,registerNumber,hallTicket,resultVersion,totalMarks,maxMarks,published_at}]}
GET  /exams/:id/exports/scripts → 403 EXPORT_LOCKED while PRECHECK/LIVE

## Question Paper (QUESTION_SETTER, PAPER_REVIEWER, EXAM_CELL_OPERATOR, CONTROLLER)
GET  /exams/:id/paper → {paper:{id,examId,title,status,version,instructions,totalMarks,sealedSha256,sections,questions:[{questionId,sectionCode,number,kind,prompt,maxMarks,rubric,attachments}]}}
PUT  /exams/:id/paper {title,instructions?,sections:[],questions:[{questionId,sectionId?,sectionCode?,questionNumber?,kind,prompt,maxMarks,expectedAnswer?,rubric?,attachments?}]} (paper:write) → {status,paperId,totalMarks,questionCount}
POST /exams/:id/paper/submit-for-review (paper:write) → {status:'REVIEW',paperId}
POST /exams/:id/paper/approve {decision:'APPROVED',feedback?} (paper:review) → {status:'APPROVED',sealedSha256}  (AES-256-GCM encrypted at rest)
POST /exams/:id/paper/reject {feedback} (paper:review) → {status:'DRAFT'}
POST /exams/:id/paper/sets {count,setCodes?:['A','B']} (paper:write) → {sets:[{setCode,questionOrder}]}
GET  /candidates/:attemptId/paper (results:write) → {paper:{id,title,total_marks,status,version,sections},questions:[...]}

## Student Profile & ID (STUDENT)
GET  /student/profile → {profile:{student:{id,fullName,email,registerNumber,admissionBatch,currentSemester,section,preferredLanguage},department,programme,documents:{photo},hallTickets:[],cumulative:{totalExams,totalMarks,totalMax,percentage,gpa}}}
POST /student/profile/photo {photoDataUrl, consentGiven:true} → 201 {sha256, byteLength, mimeType} (enforces max 2MB, audit log `student.photo_uploaded`)
GET  /student/profile/photo → binary JPEG/PNG/WebP image
GET  /student/profile/id-card → {idCard:{valid,tenantName,fullName,registerNumber,departmentCode,departmentName,programmeCode,programmeName,currentSemester,photoAvailable,issuedAt,qrDataUrl}}
GET  /student/verify-student/:hash (public) → {verification:{valid,tenantName,fullName,registerNumber,departmentCode,departmentName,programmeCode,programmeName,currentSemester,photoAvailable,issuedAt}}
GET  /student/me/exams/:examId/seb-config (attempts:own) → `.seb` Safe Exam Browser configuration file download for allocated student

## Coding languages (ADR 0011)
GET  /coding/languages (exams:read) → {judge:'CONNECTED'|'UNREACHABLE'|'NOT_CONFIGURED',error,projects:boolean|null,languages:[{id,label,version,group,judge0,installed:boolean|null,sandboxName}]}
GET  /coding/subjects (exams:read) → {subjects:[{code,name,departmentCode,profile:{languages,default}|null}],defaults}
PUT  /coding/subjects/:code {profile:{languages:[id],default?}|null} (exams:write) → {code,profile}   (audited course.code_profile_set; 404 COURSE_NOT_FOUND)
GET  /exams/:id/code-languages (exams:read) → {subject:{code,name,restricted}|null,languages:[{id,label,version,group,file}],default}
POST /exams/:id/paper/questions/:questionId/check-code (paper:write) → {questionId,passed,total,ok,results:[{test,kind:'sample'|'hidden',passed,verdict,input,expected,output,compileOutput?}]}   (runs the reference solution in expectedAnswer.reference; 422 REFERENCE_REQUIRED, 503 JUDGE_UNAVAILABLE, 409 QUESTION_CHANGED, 409 PAPER_APPROVED; approval answers 422 CODE_NOT_CHECKED until every coding question with hidden tests passes its current check)

## Safe Exam Browser & Client Policy (EXAM_CELL_OPERATOR, CONTROLLER)
POST /exams/:id/seb-config {allowQuit,quitPassword? (6–64, stored only as a hash),kioskMode,blockVirtualMachines,blockScreenCapture,blockClipboard,prohibitedProcesses? (extra apps to force-close: Name.exe or com.vendor.app)} (exams:write) → 201 {sebConfigKey,generatedAt,downloadUrl,xml,prohibitedApps}; 409 SEB_CONFIG_FROZEN once LIVE; 409 SEB_NOT_APPLICABLE unless SECURE_BYOD. Config Key per the SEB algorithm (docs/seb-rollout.md); audits `seb_config.generated`
GET  /exams/:id/seb-config (exams:read) → `.seb` Safe Exam Browser XML plist configuration file download (audits `seb_config.downloaded`); 404 SEB_CONFIG_NOT_GENERATED until POST /exams/:id/seb-config generated it — a download never writes the exam policy (same for the student download)
PUT  /exams/:id/client-policy {sebConfigKey?,sebBrowserExamKeys?:[hex64],cameraPresence?:boolean,allowedClientBuilds?,requireManagedEndpoint?,allowedSubnets?,ipPolicy?:'LOG'|'REVIEW'|'LOCK'} (exams:write) → {policy}; SEB keys and camera presence frozen once LIVE (409); changing cameraPresence starts a new policyVersion
GET  /exams/:id/client-policy (exams:read) → {policy}

## Academic Analytics (HOD, REPORT_VIEWER, EXAM_CELL_OPERATOR, CONTROLLER)
GET  /analytics/department/:departmentId (analytics:read scoped to departmentId) → {analytics:{department,summary:{totalStudents,totalExams,totalPublishedResults,avgPercentage,passCount,failCount,passRate},semesterRollups:[],examRollups:[]}}
GET  /analytics/overview (analytics:read) → {overview:{departments:[{id,code,name,studentCount,publishedRecordsCount,passRate,avgPercentage}]}}

## Candidates (post-exam)
GET  /candidates/queue?examId (marks:approve, exam-scoped) → {summary:{total,awaitingMarks,marked}, candidates:[{attemptId,status,fullName,registerNumber,hallTicket,resultVersion,totalMarks,maxMarks,markedAt,marking:'AWAITING_MARKS'|'MARKED'|'PUBLISHED'}]}   (examiner queue; carries no integrity or proctoring fields)
POST /candidates/:attemptId/forensics/run → packet
POST /candidates/:attemptId/result-versions {items:[{questionId,maxMarks,marks,explanation,criteria?:[{code,max,awarded,evidence?}],overrideReason?}]} (EVALUATOR) → 201 {resultVersionId,version,total,max,invalidatedApprovals}; 422 OVERRIDE_REASON_REQUIRED when marks differ from the server's automatic proposal without a reason (≥ 10 chars). Each stored item keeps proposedMarks, proposalMethod and overrideReason
GET  /candidates/:attemptId/checklist → {packet,exam,resultVersion,checks:[{code,ok,detail}],publishable}
POST /candidates/:attemptId/approvals {reviewedResultVersionId, reason, idempotencyKey} (EXAM_CELL) → 201 {approvalId,status}
POST /candidates/:attemptId/holds {status:'INTEGRITY_HOLD'|'TECHNICAL_REVIEW_REQUIRED'|'IDENTITY_REVIEW_REQUIRED'|'MARKING_MODERATION_REQUIRED', reason} → {status}
POST /candidates/:attemptId/holds/release {reason}
POST /candidates/:attemptId/authorize-publication {candidateApprovalId, idempotencyKey} (CONTROLLER) → {publicationGrantId,status:'PUBLISHED'}
GET  /candidates/:attemptId/booklet.pdf → PDF binary with vector diagram rendering and verification QR (exams:read; 403 EXPORT_LOCKED during PRECHECK/LIVE)
GET  /candidates/:attemptId/evidence.pdf → PDF binary restricted forensic evidence dossier (examcell:candidates:read; 403 EXPORT_LOCKED during PRECHECK/LIVE)

## Evaluation at Scale, Moderation & Revaluation (Phase 6)
POST /exams/:id/evaluators/assign {evaluatorUserId, roleType:'EVALUATOR_1'|'EVALUATOR_2'|'MODERATOR', attemptIds?, count?} (evaluation:assign) → 201 {assignedCount, evaluatorUserId, roleType}
GET  /exams/:id/evaluators/assignments (exams:read) → {summaries:[{evaluatorId,evaluatorName,evaluatorEmail,totalAssigned,inProgress,completed}], assignments:[...]}
GET  /evaluator/me/assignments?examId (marks:approve) → [{assignmentId,attemptId,examId,examTitle,examCode,examType,roleType,assignmentStatus,candidateStatus,isAnonymized,anonymizedIdentifier,candidateName,candidateEmail,hallTicketNumber}]
POST /evaluator/me/attempts/:attemptId/marks {items:[...]} (marks:approve) → 201 {resultVersionId,version,total,max,doubleEvaluation?,status?,divergence?}
GET  /exams/:id/moderation/samples (evaluation:moderate) → [{id,attemptId,reason,divergence,evaluator1Marks,evaluator2Marks,evaluator1Name,evaluator2Name,moderatorName,status,resolutionNote}]
POST /moderation/samples/:sampleId/resolve {resolutionNote, items:[...]} (evaluation:moderate) → {sampleId, status:'RESOLVED', resultVersionId}
POST /student/attempts/:attemptId/revaluation {reason, feeRef?} (attempts:own) → 201 {requestId, status:'REQUESTED'}
GET  /student/attempts/:attemptId/revaluation (attempts:own) → {revaluation:{id,reason,feeRef,status,decisionNote}}
GET  /exams/:id/revaluation-requests (revaluation:decide) → [{id,attemptId,studentName,studentEmail,reason,feeRef,status,decisionNote,currentMarks,maxMarks,packetStatus}]
POST /revaluation-requests/:requestId/decide {decision:'APPROVED'|'REJECTED', note?} (revaluation:decide) → {requestId, status}   (the Controller of Examinations only; re-marking afterwards must give a reason for every change from the published mark: 422 REVALUATION_REASON_REQUIRED)
GET  /candidates/:attemptId/rubric-proposals (marks:approve) → {attemptId, proposedTotal, needsExaminer:[questionId], proposals:[{questionId,maxMarks,proposedMarks|null,method:'NO_ANSWER'|'ANSWER_KEY'|'NUMERIC_KEY'|'RUBRIC_TERMS'|'CODE_TESTS'|'EXAMINER',basis,criteria?:[{code,max,awarded,evidence}],tests?:[{test,passed,verdict,weight,input,expected,output,compileOutput?}]}]} — deterministic: MCQ/NUMERIC answer key (expectedAnswer), rubric criteria `keywords`; null = the examiner judges (drawings, no key)
POST /exams/:id/auto-evaluate (evaluation:assign) → {evaluated,scriptsToReadCarefully,scriptsWithQuestionsForTheExaminer}   (re-runs the system's evaluation for every script still in marking; it also runs automatically when forensics hand a script to marking; marks already recorded are never touched)
POST /exams/:id/publish-results {idempotencyKey} (controller:publish — the COE) → {publishedAt,published,withheld:[{attemptId,status}],replayed}   (releases every approved result of a CLOSED exam at once; 409 RESULTS_NOT_READY while any script awaits marks or approval; held candidates are withheld. Before this, POST /candidates/:attemptId/authorize-publication answers 409 MASS_PUBLICATION_REQUIRED; after it, only released holds and revaluation outcomes are published one by one)
POST /exams/:id/similarity-analysis {threshold?} (exams:write) → {examId, threshold, comparisonsCount, flaggedPairs:[{attemptId1,attemptId2,questionId,similarity}]}

## Proctor (PROCTOR, CHIEF_PROCTOR)
GET  /proctor/incidents?examId&status&limit → {incidents:[{id,attempt_id,exam_id,signal_class,status,first_event_at,last_event_at,event_count,priority,attemptStatus,userId,studentName,currentWarnings,epochNo}]}
POST /proctor/incidents/:id/decision {action:'DISMISS'|'CONFIRM_WARNING'|'MARK_TECHNICAL'|'ESCALATE'|'INVALIDATE_REQUEST', reasonCode, notes, idempotencyKey} → {decisionId,attemptStatus,suspensionKind,authorizationGeneration,epoch:{no,confirmedCount,open},lifetimeWarnings}
POST /proctor/attempts/:id/technical-holds {reasonCode,notes,idempotencyKey}
POST /proctor/attempts/:id/resume {reasonCode,notes,idempotencyKey,deadlineExtensionMinutes,rebindDevice} (CHIEF_PROCTOR)
GET  /proctor/attempts/:id/timeline → {attempt,events,warnings,epochs,network:[{ip,user_agent,first_seen_at,last_seen_at,observations,first_source,in_allowed_subnet}],deviceScans:[{id,phase,verdict,findings,ip,user_agent,scan_sha256,created_at}],signals:[{id,incident_id,signal_class,source_id,metadata,client_recorded_at,server_received_at}] (newest 500)}   (raw scans stay in the device_scans table; the evidence PDF lists both)

## Tenant admin (TENANT_ADMIN / SYSTEM_ADMIN)
POST /tenant/users {email,fullName,kind:'STUDENT'|'STAFF',externalId?,provider?,roles:[{role,scopeType?,scopeId?}]} (users:write) → 201 {userId,activationDispatchId} (activation mail queued; 409 STAFF_LOGIN_LIMIT when no staff seat is free)
GET  /tenant/users?q&kind (users:read) → {users:[{id,email,fullName,kind,status,registerNumber,createdAt}]}   (max 200)
GET  /tenant/staff-seats (users:read) → {limit,used,free,bundles,staff:[{…,roles:[{role,scopeType,scopeId}]}]}
PATCH /tenant/users/:id/status {status:'ACTIVE'|'INACTIVE'|'SUSPENDED'|'PENDING_ACTIVATION', reason?} (users:write) → {status}
GET  /tenant/users/:id/roles (users:read) → {roles:[{id,role,scopeType,scopeId,effectiveFrom,effectiveUntil}]}
POST /tenant/users/:id/roles {role,scopeType,scopeId} (users:write) → 201 {grantId}
DELETE /tenant/users/:id/roles {role,scopeType,scopeId} (users:write) → {revoked}
PUT  /tenant/mail-config {transportKind,senderAddress,senderName,endpointSecret?,tokenSecret?,callbackSecret?,category?,settings} (mail:manage) → 204 (secrets sealed, never returned)
GET  /tenant/mail-dispatches (mail:manage) → {dispatches:[{id,category,lane,toAddress,subject,status,attemptCount,transportKind,lastError,createdAt,acceptedAt}]}
PUT  /tenant/sso-config {provider:'entra'|'google'|'generic',issuer,clientId,clientSecret?|clientSecretRef?,allowedEmailDomains,enabled} (tenant:manage) → 204
POST /tenant/api-keys {label,scopes,expiresAt?,allowedIps?,connectionId?,env?:'live'|'test'} (integration:manage) → 201 {id,keyId,apiKey,note} (plaintext key shown once)
GET  /tenant/api-keys (integration:manage) → {apiKeys:[{id,label,keyId,scopes,expiresAt,lastUsedAt,revokedAt,createdAt}]}
DELETE /tenant/api-keys/:id (integration:manage) → 204 (revoked)
POST /tenant/webhooks {url,description?,eventTypes} (integration:manage) → 201 {id,signingSecret,note} (secret shown once)
GET  /tenant/webhooks (integration:manage) → {webhooks:[{id,url,description,eventTypes,status,createdAt}]}
DELETE /tenant/webhooks/:id (integration:manage) → 204 (endpoint disabled)
GET  /tenant/webhooks/deliveries (integration:manage) → {deliveries:[{id,eventType,status,attempts,lastStatusCode,lastError,nextAttemptAt,deliveredAt,url}]}
POST /tenant/webhooks/deliveries/:id/replay (integration:manage) → 202
GET  /tenant/audit (audit:read) → {events:[…]} (latest 500)

## Platform (super admin; tenant-less)
Authenticated by a platform session token (`Authorization: Bearer`, tid `platform`) or, outside production only, `x-platform-key: <PLATFORM_BOOTSTRAP_KEY>`; 401 PLATFORM_ACCESS_REQUIRED otherwise, 403 for a tenant user's token.
POST /platform/auth/login {email,password,otp} (public; 10/5 min per IP) → {accessToken,expiresAt,email}   (401 LOGIN_FAILED; lockout after 5 failures)
POST /platform/auth/logout → 204 (revokes the platform session; a no-op for the bootstrap key)
GET  /platform/me → {email,via:'SESSION'|'BOOTSTRAP_KEY'}
GET  /platform/tenants → {tenants:[{id,slug,name,status,timezone,staffLoginLimit,staffCount,studentCount,domains}]}
POST /platform/tenants {slug,name,groupCode?,timezone?,domains,adminEmail,adminFullName,staffLoginLimit?:3|4} → 201 {tenantId,adminUserId}   (admin activation mail queued)
PATCH /platform/tenants/:id {name?,status?:'ACTIVE'|'SUSPENDED',staffLoginLimit?:3|4,domains?} → 204   (suspension revokes every session; 409 DOMAIN_IN_USE, STAFF_LIMIT_BELOW_USAGE)
GET  /platform/overview → {tenants:[{tenantId,name,slug,status,examsByStatus,attemptsInProgress,openIncidents}]}
GET  /platform/tenants/:id/staff → {limit,used,free,bundles,staff:[…]}
PUT  /platform/tenants/:id/staff/:userId/roles {roles:[RoleCode≠STUDENT],bundle?:'ADMIN_CONTROLLER'|'EXAM_OFFICE'|'CHIEF_REVIEWER'|'EXAMINER'} → 204   (422 ROLES_REQUIRED / ROLE_KIND_MISMATCH)
POST /platform/tenants/:id/staff/:userId/reissue-activation → 202 {dispatchId}   (unlocks and mails a fresh activation link to the staff member's own mailbox)
GET  /platform/audit → {events:[…]} (latest 100 platform-level audit events)

## Simple Integration API (ERP; tenant from the API key)
Authenticated by `Authorization: Bearer exk_<live|test>_<keyId>_<secret>` (or `x-api-key`); 401 API_KEY_INVALID without a valid key, 403 SCOPE_MISSING. Provider from the key's ERP connection or `X-ExamOS-Provider` (default `erp`). Roster batches require `Idempotency-Key`.
PUT  /integration/v1/roster/persons/batch {rows:[Person],mode?:'UPSERT'|'CREATE_ONLY'|'UPDATE_ONLY',sourceLabel?} (roster:write) → {syncJobId,summary:{created,updated,unchanged,rejected,identityConflicts},rows:[{index,externalId,outcome,code,message}]}   (≤ 500 rows)
PUT  /integration/v1/roster/academic-units/batch {rows:[AcademicUnit],mode?,sourceLabel?} (roster:write) → same shape
PUT  /integration/v1/roster/courses/batch {rows:[Course],mode?,sourceLabel?} (roster:write) → same shape
PUT  /integration/v1/roster/enrollments/batch {rows:[Enrollment],mode?,sourceLabel?} (roster:write) → same shape
GET  /integration/v1/roster/sync-jobs/:id (roster:read) → {job,rows}   (400 INVALID_ID, 404 SYNC_JOB_NOT_FOUND)
GET  /integration/v1/events?since&limit&types (events:read) → cursor feed of signed event envelopes {id,type,tenantId,occurredAt,version,data}
GET  /integration/v1/results?examCode&since (results:read) → {examCode,results:[{examCode,examType,academicYear,semester,provider,studentExternalId,hallTicketNumber,marks,maxMarks,grade,publishedAt,resultVersionId}]}   (published results only)
POST /integration/v1/webhooks {url,description?,eventTypes} (webhooks:manage) → 201 {id,signingSecret}
POST /integration/v1/mail/callbacks {dispatchId,outcome:'ACCEPTED'|'FAILED',providerMessageId?,error?} (Power Automate flow; `Authorization: Bearer <tenant callback secret>`, 401 CALLBACK_TOKEN_REQUIRED before any validation) → {result}

## ERP Adapters, XLSX Import & Mail Completeness (Phase 7)
GET  /integration/v1/roster/templates/:entity (roster:read) → CSV template download for PERSON | ACADEMIC_UNIT | COURSE | ENROLLMENT
POST /integration/v1/roster/preview {entity, csvContent, mode, provider?} (roster:write) → {entity, total, summary:{created, updated, unchanged, rejected, identityConflicts}, sampleRows}
POST /integration/v1/roster/import-xlsx {entity, csvContent, mode, provider?, sourceLabel?} (roster:write) → 200 {syncJobId, summary, rows}
POST /integration/v1/mail/bounces {providerMessageId?, toAddress, reason?, diagnosticCode?, bouncedAt?} (`Authorization: Bearer <tenant callback secret>`; 401 CALLBACK_TOKEN_REQUIRED before any validation) → {reconciled:boolean, dispatchId, toAddress}
POST /tenant/erp-connections {provider, label, baseUrl, credentialSecret?, webhookSecret?, syncScheduleCron?, mapping, status} (integration:manage) → 201 {id}
GET  /tenant/erp-connections (integration:manage) → {connections:[{id,provider,label,base_url,sync_schedule_cron,mapping,status,last_sync_at,created_at}]}
GET  /tenant/erp-connections/:id (integration:manage) → {connection}
PUT  /tenant/erp-connections/:id {label?, baseUrl?, syncScheduleCron?, mapping?, status?, credentialSecret?, webhookSecret?} (integration:manage) → 204
POST /tenant/erp-connections/:id/sync {entity, mode, dryRun} (integration:manage) → {dryRun:boolean, results | summary, sampleRows}
GET  /tenant/erp-connections/:id/jobs (integration:manage) → {jobs:[{id,entity,mode,source,status,summary,started_at,completed_at}]}
GET  /tenant/mail/health (mail:manage) → {totalDispatches, accepted, delivered, bounced, failed, queued, sending, bounceRatePct, byTransport, byLane, dailyExternalQuota:{sentToday, limit, remaining}}
POST /tenant/mail/bounces {providerMessageId?, toAddress, reason?, diagnosticCode?, bouncedAt?} (mail:manage) → {reconciled:boolean, dispatchId, toAddress}
GET  /tenant/roster/templates/:entity (roster:read) → CSV template download
POST /tenant/roster/preview {entity, csvContent, mode, provider?} (roster:write) → {entity, total, summary, sampleRows}
POST /tenant/roster/import {entity, csvContent, mode, provider?, sourceLabel?} (roster:write) → {syncJobId, summary, rows}
GET  /tenant/roster/sync-jobs?source (roster:read) → {jobs:[...]}
