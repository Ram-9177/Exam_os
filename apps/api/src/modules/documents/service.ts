import type { Knex } from '@examos/db';
import type { AppDeps } from '../../types.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { answerBooklet } from '../candidates/service.js';
import { assertExportAllowed } from '../exams/service.js';
import { attemptTimeline } from '../proctoring/service.js';
import { getDocumentStorage } from './storage.js';
import { generateQrDataUrl } from './qr.js';
import { renderBookletHtml, renderHallTicketHtml, renderEvidenceHtml, renderHtmlToPdf } from './renderer.js';

export interface Caller {
  userId: string;
  kind: 'STUDENT' | 'STAFF';
  roles: string[];
}

export interface RenderResult {
  data: Buffer;
  sha256: string;
  contentType: string;
  filename: string;
}

export async function getOrRenderBookletPdf(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  attemptId: string,
  caller: Caller,
  host: string,
): Promise<RenderResult> {
  const attempt = await trx('exam_attempts').where({ tenant_id: tenantId, id: attemptId }).first();
  if (!attempt) throw AppError.notFound('ATTEMPT_NOT_FOUND', 'Exam attempt not found');

  const isStaff = caller.kind === 'STAFF';

  // Check export lock if staff requests it during PRECHECK or LIVE (must record audit row + throw EXPORT_LOCKED before anything else)
  if (isStaff) {
    await assertExportAllowed(deps, trx, tenantId, attempt.exam_id, caller.userId, 'booklet.pdf');
  }

  const packet = await trx('candidate_review_packets').where({ tenant_id: tenantId, attempt_id: attemptId }).first();
  if (!packet) throw AppError.notFound('PACKET_NOT_FOUND', 'Candidate review packet not found');

  if (isStaff) {
    await audit(trx, {
      tenantId,
      actorType: 'USER',
      actorId: caller.userId,
      action: 'booklet.downloaded',
      entityType: 'attempt',
      entityId: attemptId,
      metadata: { packetStatus: packet.status, isPrePublication: packet.status !== 'PUBLISHED' },
    });
  }

  if (!isStaff && packet.user_id !== caller.userId) {
    throw AppError.notFound('PACKET_NOT_FOUND', 'Candidate review packet not found');
  }

  // Student can only access booklet after publication
  if (!isStaff && packet.status !== 'PUBLISHED') {
    throw AppError.conflict('NOT_PUBLISHED', 'The booklet PDF is available after the result is published');
  }

  const resultVersion = packet.result_version_id
    ? await trx('result_versions').where('id', packet.result_version_id).first('version')
    : null;
  const versionNo = resultVersion?.version ?? 0;
  const entityId = `${attemptId}:v${versionNo}`;

  // Check cache in stored_documents and storage
  const storage = getDocumentStorage();
  const cachedDoc = await trx('stored_documents')
    .where({ tenant_id: tenantId, doc_kind: 'BOOKLET_PDF', entity_id: entityId })
    .first();

  if (cachedDoc) {
    const fileObj = await storage.getObject(tenantId, 'documents', `booklet_${entityId}.pdf`);
    if (fileObj) {
      return {
        data: fileObj.data,
        sha256: cachedDoc.sha256,
        contentType: 'application/pdf',
        filename: `Booklet_${attemptId}_v${versionNo}.pdf`,
      };
    }
  }

  // Build booklet data using existing service
  const booklet = await answerBooklet(trx, tenantId, attemptId, { userId: caller.userId, isStaff });

  const qrUrl = `https://${host}/verify/${attemptId}/${versionNo}`;
  const qrDataUrl = await generateQrDataUrl(qrUrl);
  const html = renderBookletHtml(booklet, qrDataUrl);
  const pdfBuffer = await renderHtmlToPdf(html);

  const storageKey = `booklet_${entityId}.pdf`;
  const stored = await storage.putObject(tenantId, 'documents', storageKey, pdfBuffer, 'application/pdf');

  await trx('stored_documents')
    .insert({
      tenant_id: tenantId,
      doc_kind: 'BOOKLET_PDF',
      entity_id: entityId,
      blob_ref: stored.blobRef,
      sha256: stored.sha256,
      byte_length: stored.byteLength,
      mime_type: 'application/pdf',
      metadata: { attemptId, version: versionNo, qrUrl },
    })
    .onConflict(['tenant_id', 'doc_kind', 'entity_id'])
    .merge();

  return {
    data: pdfBuffer,
    sha256: stored.sha256,
    contentType: 'application/pdf',
    filename: `Booklet_${attemptId}_v${versionNo}.pdf`,
  };
}

export async function getOrRenderHallTicketPdf(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  examId: string,
  userId: string,
  caller: Caller,
  host: string,
): Promise<RenderResult> {
  const isStaff = caller.kind === 'STAFF';
  if (!isStaff && userId !== caller.userId) {
    throw AppError.forbidden('FORBIDDEN', 'Cannot access hall ticket of another student');
  }

  const ht = await trx('hall_tickets')
    .where({ tenant_id: tenantId, exam_id: examId, user_id: userId })
    .whereNull('revoked_at')
    .first();

  if (!ht) {
    throw AppError.notFound('HALL_TICKET_NOT_FOUND', 'No active hall ticket issued for this exam');
  }

  const storage = getDocumentStorage();
  const entityId = `${examId}:${userId}`;
  const cachedDoc = await trx('stored_documents')
    .where({ tenant_id: tenantId, doc_kind: 'HALL_TICKET_PDF', entity_id: entityId })
    .first();

  if (cachedDoc) {
    const fileObj = await storage.getObject(tenantId, 'documents', `hallticket_${entityId}.pdf`);
    if (fileObj) {
      return {
        data: fileObj.data,
        sha256: cachedDoc.sha256,
        contentType: 'application/pdf',
        filename: `HallTicket_${ht.number}.pdf`,
      };
    }
  }

  const [exam, user, profile, tenant] = await Promise.all([
    trx('exams').where({ tenant_id: tenantId, id: examId }).first(),
    trx('users').where({ tenant_id: tenantId, id: userId }).first('full_name', 'email'),
    trx('student_profiles').where({ tenant_id: tenantId, user_id: userId }).first('register_number', 'current_semester'),
    trx('tenants').where('id', tenantId).first('name'),
  ]);

  if (!exam || !user) throw AppError.notFound('EXAM_OR_USER_NOT_FOUND');

  const dept = exam.course_id
    ? await trx('courses as c').join('departments as d', 'd.id', 'c.department_id').where('c.id', exam.course_id).first('d.name as departmentName', 'd.code as departmentCode')
    : null;

  const ticketData = {
    number: ht.number,
    tenantName: tenant?.name,
    studentName: user.full_name,
    registerNumber: profile?.register_number,
    semester: profile?.current_semester ?? exam.semester,
    examTitle: exam.title,
    examCode: exam.code,
    academicYear: exam.academic_year,
    windowStartAt: exam.window_start_at,
    windowEndAt: exam.window_end_at,
    durationMinutes: exam.duration_minutes,
    securityProfile: exam.security_profile,
    departmentName: dept?.departmentName,
    departmentCode: dept?.departmentCode,
    verificationHash: ht.verification_hash,
  };

  const qrUrl = `https://${host}/student/verify/ticket/${ht.verification_hash}`;
  const qrDataUrl = await generateQrDataUrl(qrUrl);
  const html = renderHallTicketHtml(ticketData, qrDataUrl);
  const pdfBuffer = await renderHtmlToPdf(html);

  const storageKey = `hallticket_${entityId}.pdf`;
  const stored = await storage.putObject(tenantId, 'documents', storageKey, pdfBuffer, 'application/pdf');

  await trx('hall_tickets').where('id', ht.id).update({ pdf_object_ref: stored.blobRef });

  await trx('stored_documents')
    .insert({
      tenant_id: tenantId,
      doc_kind: 'HALL_TICKET_PDF',
      entity_id: entityId,
      blob_ref: stored.blobRef,
      sha256: stored.sha256,
      byte_length: stored.byteLength,
      mime_type: 'application/pdf',
      metadata: { examId, userId, number: ht.number },
    })
    .onConflict(['tenant_id', 'doc_kind', 'entity_id'])
    .merge();

  return {
    data: pdfBuffer,
    sha256: stored.sha256,
    contentType: 'application/pdf',
    filename: `HallTicket_${ht.number}.pdf`,
  };
}

export async function getOrRenderEvidencePdf(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  attemptId: string,
  caller: Caller,
  host: string,
): Promise<RenderResult> {
  const attempt = await trx('exam_attempts').where({ tenant_id: tenantId, id: attemptId }).first();
  if (!attempt) throw AppError.notFound('ATTEMPT_NOT_FOUND', 'Attempt not found');

  // Enforce export lock during PRECHECK/LIVE
  await assertExportAllowed(deps, trx, tenantId, attempt.exam_id, caller.userId, 'evidence.pdf');

  const [packet, exam, user, profile, manifest, timeline] = await Promise.all([
    trx('candidate_review_packets').where({ tenant_id: tenantId, attempt_id: attemptId }).first(),
    trx('exams').where({ tenant_id: tenantId, id: attempt.exam_id }).first(),
    trx('users').where({ tenant_id: tenantId, id: attempt.user_id }).first('full_name', 'email'),
    trx('student_profiles').where({ tenant_id: tenantId, user_id: attempt.user_id }).first('register_number'),
    trx('submission_manifests').where({ tenant_id: tenantId, attempt_id: attemptId }).first(),
    attemptTimeline(trx, tenantId, attemptId),
  ]);

  if (!packet || !exam || !user) throw AppError.notFound('PACKET_NOT_FOUND');

  const evidenceData = {
    attemptId,
    studentName: user.full_name,
    registerNumber: profile?.register_number,
    examTitle: exam.title,
    examCode: exam.code,
    integrityState: packet.integrity_state,
    identityState: packet.identity_state,
    manifestSha256: manifest?.manifest_sha256,
    events: timeline.events,
    warnings: timeline.warnings,
    network: timeline.network,
    deviceScans: timeline.deviceScans,
  };

  const qrUrl = `https://${host}/candidates/${attemptId}/checklist`;
  const qrDataUrl = await generateQrDataUrl(qrUrl);
  const html = renderEvidenceHtml(evidenceData, qrDataUrl);
  const pdfBuffer = await renderHtmlToPdf(html);

  const storage = getDocumentStorage();
  const entityId = attemptId;
  const storageKey = `evidence_${attemptId}.pdf`;
  const stored = await storage.putObject(tenantId, 'documents', storageKey, pdfBuffer, 'application/pdf');

  await trx('stored_documents')
    .insert({
      tenant_id: tenantId,
      doc_kind: 'EVIDENCE_PDF',
      entity_id: entityId,
      blob_ref: stored.blobRef,
      sha256: stored.sha256,
      byte_length: stored.byteLength,
      mime_type: 'application/pdf',
      metadata: { attemptId, examId: attempt.exam_id },
    })
    .onConflict(['tenant_id', 'doc_kind', 'entity_id'])
    .merge();

  return {
    data: pdfBuffer,
    sha256: stored.sha256,
    contentType: 'application/pdf',
    filename: `Evidence_${attemptId}.pdf`,
  };
}
