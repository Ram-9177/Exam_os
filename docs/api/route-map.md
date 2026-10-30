# ExamOS API route map (all JSON; errors are RFC7807 problem objects with `code`)

Base: `/api/v1`. Tenant is resolved from the request Host header (dev: `localhost` must be registered as a tenant domain; use Vite proxy with `changeOrigin: false` and `headers: { Host: '<tenant-host>' }`, or run the API with the tenant host mapped in /etc/hosts).
Auth: `Authorization: Bearer <accessToken>` (10-min RS256 JWT); refresh with `POST /auth/refresh {refreshToken}`; 401 with code `TOKEN_INVALID` → refresh once then retry; `SESSION_REVOKED` → logout.
Student exam requests after admission MUST send header `x-device-session: <deviceSessionId returned by admit/reconnect>`.

## Public (host tenant)
GET  /tenant → {id, slug, name, timezone, ssoProvider}
POST /auth/login {email,password} → {accessToken, refreshToken, expiresIn, user:{id,email,fullName,kind}}
POST /auth/refresh {refreshToken} → same shape
POST /auth/activate {token,password} → same shape (token comes from the activation e-mail link ?token=)
POST /auth/logout (auth) → 204
GET  /auth/me (auth) → {userId,email,kind,grants:[{role,scopeType,scopeId}],tenant}
GET  /auth/oidc/start?redirectUri= → {authorizationUrl,state}; POST /auth/oidc/callback {code,state} → token pair
GET  /student/verify/:attemptId/:version → {valid,published,version,publishedAt,total,max}   (public result verification page)

## Student (role STUDENT; permission attempts:own)
GET  /student/me/exams → {exams:[{examId,code,title,examType,academicYear,semester,examStatus,securityProfile,durationMinutes,windowStartAt,windowEndAt,courseCode,courseName,extraTimeMinutes,attemptId,attemptStatus,deadlineAt,hallTicketNumber,hallTicketVerification}]}
GET  /student/me/exams/:examId/hall-ticket.pdf → PDF binary with verification QR (embedded signed hash)
GET  /student/me/ledger → {records:[{exam_type,academic_year,semester,marks,max_marks,grade,hall_ticket_number,published_at,examCode,examTitle,courseCode,courseName}], semesters:[{academic_year,semester,exams,marks,max_marks,percentage}], overall:{exams,semesters,marks,max_marks,percentage}}
GET  /student/attempts/:id/paper (student own, exam LIVE) → {paper:{paper_id,title,total_marks,sections,setCode},questions:[{question_id,section_id,question_number,kind,prompt,max_marks,options}]} (expected_answer and rubric stripped)
POST /student/attempts/:attemptId/prechecks {clientBuild} → 201 {runId, checks:[{code,status,source,diagnosticCode,remediationCode,instruction,optional}]}   (409 PRECHECK_NOT_OPEN until Exam Section opens it)
POST /student/prechecks/:runId/items/verify {code, clientBuild?, clientClockMs?, keyboardSample?, canvasOps?, consentPolicyVersion?, scan?} → {checks:[...]}
     codes: CLIENT_VERSION, CLOCK_SYNC(clientClockMs=Date.now()), KEYBOARD_INPUT(keyboardSample≥20 chars with letters, digits, punctuation), CANVAS_INPUT(canvasOps count; OPTIONAL — stylus optional), NETWORK_SAVE_ROUNDTRIP(after a practice save), CONSENT(consentPolicyVersion = policyVersion from GET /student/attempts/:id/policy), CAMERA, MICROPHONE (client-declared; high-tier profiles show UNVERIFIABLE honestly until the media pipeline exists), SYSTEM_SCAN(scan = raw DeviceScan; the server derives findings, appends a device_scans row and records the item as CLIENT_DECLARED — a BLOCKING finding is REMEDIATE/FIX_DEVICE_SETTINGS, a clean scan is never a security PASS)
GET  /student/attempts/:attemptId/policy → {attemptId,attemptStatus,examId,examTitle,examStatus,securityProfile,policyVersion,durationMinutes,windowStartAt,windowEndAt,consentPurposes,checks:[{code,mandatory,serverMeasured,optional,securityRelevant}],allowedClientBuilds,monitoringNotice}
     IDENTITY_SESSION and ELIGIBILITY are server-measured (400 if submitted)
POST /student/prechecks/:runId/practice-saves {contentDigest: sha256 hex} → {revision, ackAt}
POST /student/prechecks/:runId/finalize → {precheckId,status:'READY'|'REMEDIATE'|'REVIEW',securityProfile,checks:[{...,mandatory,coveredByException,securityRelevant}],examTimerStarted:false,readyUntil,helpAction}
POST /student/attempts/:attemptId/entry-grants → 201 {grantToken, expiresAt}   (409 EXAM_NOT_STARTED = lobby: "waiting for the Examination Section to start"; 409 NOT_READY; PRECHECK_STALE)
POST /student/attempts/:attemptId/admit {grantToken} → {attemptId,status:'ACTIVE',serverNow,deadlineAt,authorizationGeneration,warningEpochId,deviceSessionId}
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
POST /proctor/events {events:[{sourceEventId,attemptId,signalClass,clientRecordedAt?,clientSequence?,metadata}]} → 202 (student client reports FOCUS_LOST, FULLSCREEN_EXIT for its own attempt)

## Exam Section / Controller (EXAM_CELL_OPERATOR, CONTROLLER)
GET  /exams?status&examType&academicYear&semester&departmentCode&schoolCode&q → {exams:[{id,code,title,status,examType,academicYear,semester,securityProfile,durationMinutes,windowStartAt,windowEndAt,courseCode,courseName,departmentCode,departmentName,schoolCode,schoolName}]}
POST /exams {code,title,courseCode,examType,academicYear,semester,maxMarks,securityProfile,durationMinutes,windowStartAt,windowEndAt,warningThreshold,policy} → 201 {examId}
GET  /exams/:id → {exam, attemptCounts}
POST /exams/:id/submit-for-review | approve | schedule | open-precheck | start | close | archive | cancel → {from,to}   (close → {from,to:'CLOSED',sealing:{sealed,pending}}: every open attempt's deadline becomes now in one statement, then attempts are sealed one transaction each — inline up to 200 / 8 s, the rest by the worker's seal-closed-exams loop within seconds; a per-attempt deadline-sweep loop seals students whose own time ran out while the exam stays LIVE)
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

## Safe Exam Browser & Client Policy (EXAM_CELL_OPERATOR, CONTROLLER)
POST /exams/:id/seb-config {allowQuit,quitPassword?,kioskMode,blockVirtualMachines,blockScreenCapture,blockClipboard,prohibitedProcesses?} (exams:write) → 201 {sebConfigKey,generatedAt,downloadUrl} (builds deterministic XML plist and audits `seb_config.generated`)
GET  /exams/:id/seb-config (exams:read) → `.seb` Safe Exam Browser XML plist configuration file download (audits `seb_config.downloaded`); 404 SEB_CONFIG_NOT_GENERATED until POST /exams/:id/seb-config generated it — a download never writes the exam policy (same for the student download)
PUT  /exams/:id/client-policy {sebConfigKey?,allowedClientBuilds?,requireManagedEndpoint?,allowedSubnets?,ipPolicy?:'LOG'|'REVIEW'|'LOCK'} (exams:write) → {policy}
GET  /exams/:id/client-policy (exams:read) → {policy}

## Academic Analytics (HOD, REPORT_VIEWER, EXAM_CELL_OPERATOR, CONTROLLER)
GET  /analytics/department/:departmentId (analytics:read scoped to departmentId) → {analytics:{department,summary:{totalStudents,totalExams,totalPublishedResults,avgPercentage,passCount,failCount,passRate},semesterRollups:[],examRollups:[]}}
GET  /analytics/overview (analytics:read) → {overview:{departments:[{id,code,name,studentCount,publishedRecordsCount,passRate,avgPercentage}]}}

## Candidates (post-exam)
POST /candidates/:attemptId/forensics/run → packet
POST /candidates/:attemptId/result-versions {items:[{questionId,maxMarks,marks,explanation,criteria?:[{code,max,awarded,evidence?}]}]} (EVALUATOR) → 201 {resultVersionId,version,total,max,invalidatedApprovals}
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
POST /revaluation-requests/:requestId/decide {decision:'APPROVED'|'REJECTED', note?} (revaluation:decide) → {requestId, status}
GET  /candidates/:attemptId/rubric-proposals (marks:approve) → {attemptId, proposals:[{questionId,maxMarks,suggestedMarks,suggestionExplanation,criteriaSuggestions:[{code,max,awarded}]}]}
POST /exams/:id/similarity-analysis {threshold?} (exams:write) → {examId, threshold, comparisonsCount, flaggedPairs:[{attemptId1,attemptId2,questionId,similarity}]}

## Proctor (PROCTOR, CHIEF_PROCTOR)
GET  /proctor/incidents?examId&status&limit → {incidents:[{id,attempt_id,exam_id,signal_class,status,first_event_at,last_event_at,event_count,priority,attemptStatus,userId,studentName,currentWarnings,epochNo}]}
POST /proctor/incidents/:id/decision {action:'DISMISS'|'CONFIRM_WARNING'|'MARK_TECHNICAL'|'ESCALATE'|'INVALIDATE_REQUEST', reasonCode, notes, idempotencyKey} → {decisionId,attemptStatus,suspensionKind,authorizationGeneration,epoch:{no,confirmedCount,open},lifetimeWarnings}
POST /proctor/attempts/:id/technical-holds {reasonCode,notes,idempotencyKey}
POST /proctor/attempts/:id/resume {reasonCode,notes,idempotencyKey,deadlineExtensionMinutes,rebindDevice} (CHIEF_PROCTOR)
GET  /proctor/attempts/:id/timeline → {attempt,events,warnings,epochs,network:[{ip,user_agent,first_seen_at,last_seen_at,observations,first_source,in_allowed_subnet}],deviceScans:[{id,phase,verdict,findings,ip,user_agent,scan_sha256,created_at}]}   (raw scans stay in the device_scans table; the evidence PDF lists both)

## Tenant admin (TENANT_ADMIN / SYSTEM_ADMIN)
POST /tenant/users; GET /tenant/users?q&kind; POST|DELETE /tenant/users/:id/roles {role,scopeType,scopeId}
PUT  /tenant/mail-config {transportKind,senderAddress,senderName,endpointSecret?,tokenSecret?,callbackSecret?,category?,settings}
GET  /tenant/mail-dispatches; PUT /tenant/sso-config; POST /tenant/api-keys; DELETE /tenant/api-keys/:id; POST /tenant/webhooks; GET /tenant/webhooks/deliveries; POST /tenant/webhooks/deliveries/:id/replay; GET /tenant/audit

## ERP Adapters, XLSX Import & Mail Completeness (Phase 7)
GET  /integration/v1/roster/templates/:entity (roster:read) → CSV template download for PERSON | ACADEMIC_UNIT | COURSE | ENROLLMENT
POST /integration/v1/roster/preview {entity, csvContent, mode, provider?} (roster:write) → {entity, total, summary:{created, updated, unchanged, rejected, identityConflicts}, sampleRows}
POST /integration/v1/roster/import-xlsx {entity, csvContent, mode, provider?, sourceLabel?} (roster:write) → 200 {syncJobId, summary, rows}
POST /integration/v1/mail/bounces {providerMessageId?, toAddress, reason?, diagnosticCode?, bouncedAt?} → {reconciled:boolean, dispatchId, toAddress}
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
