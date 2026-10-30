import type { Knex } from '@examos/db';
import type { AppDeps } from '../../types.js';
import { AppError } from '../../lib/errors.js';
import { sha256Hex } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { getDocumentStorage } from '../documents/storage.js';
import { generateQrDataUrl } from '../documents/qr.js';
import type { PhotoUploadInput, StudentProfileData, IdCardVerificationData } from '@examos/contracts';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function getStudentProfile(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  userId: string,
): Promise<StudentProfileData> {
  const user = await trx('users')
    .where({ tenant_id: tenantId, id: userId, kind: 'STUDENT' })
    .first('id', 'full_name', 'email');
  if (!user) throw AppError.notFound('STUDENT_NOT_FOUND', 'Student profile not found');

  const profile = await trx('student_profiles')
    .where({ tenant_id: tenantId, user_id: userId })
    .first();

  const [dept, prog, photoDoc, hallTickets, examRecords] = await Promise.all([
    profile?.department_id
      ? trx('departments').where({ tenant_id: tenantId, id: profile.department_id }).first('id', 'code', 'name')
      : null,
    profile?.programme_id
      ? trx('programmes').where({ tenant_id: tenantId, id: profile.programme_id }).first('id', 'code', 'name')
      : null,
    trx('student_documents')
      .where({ tenant_id: tenantId, user_id: userId, kind: 'PHOTO' })
      .first('sha256', 'mime_type', 'created_at'),
    trx('hall_tickets as ht')
      .join('exams as e', 'e.id', 'ht.exam_id')
      .where({ 'ht.tenant_id': tenantId, 'ht.user_id': userId })
      .whereNull('ht.revoked_at')
      .select(
        'ht.exam_id as examId',
        'e.code as examCode',
        'e.title as examTitle',
        'e.exam_type as examType',
        'ht.number as hallTicketNumber',
        'ht.verification_hash as hallTicketVerification',
        'e.window_start_at as windowStartAt',
        'e.window_end_at as windowEndAt',
      )
      .orderBy('e.window_start_at', 'desc'),
    trx('student_exam_records')
      .where({ tenant_id: tenantId, user_id: userId })
      .whereNull('superseded_at')
      .select('marks', 'max_marks', 'grade'),
  ]);

  const totalExams = examRecords.length;
  const totalMarks = round2(examRecords.reduce((sum, r) => sum + Number(r.marks), 0));
  const totalMax = round2(examRecords.reduce((sum, r) => sum + Number(r.max_marks), 0));
  const percentage = totalMax > 0 ? round2((totalMarks / totalMax) * 100) : 0;
  const gpa = round2(percentage / 10);

  return {
    student: {
      id: user.id,
      fullName: user.full_name,
      email: user.email,
      registerNumber: profile?.register_number ?? null,
      admissionBatch: profile?.admission_batch ?? null,
      currentSemester: profile?.current_semester ?? null,
      section: profile?.section ?? null,
      preferredLanguage: profile?.preferred_language ?? null,
    },
    department: dept ? { id: dept.id, code: dept.code, name: dept.name } : null,
    programme: prog ? { id: prog.id, code: prog.code, name: prog.name } : null,
    documents: {
      photo: photoDoc
        ? {
            sha256: photoDoc.sha256,
            createdAt: new Date(photoDoc.created_at).toISOString(),
            mimeType: photoDoc.mime_type,
          }
        : null,
    },
    hallTickets: hallTickets.map((ht) => ({
      ...ht,
      windowStartAt: new Date(ht.windowStartAt).toISOString(),
      windowEndAt: new Date(ht.windowEndAt).toISOString(),
    })),
    cumulative: {
      totalExams,
      totalMarks,
      totalMax,
      percentage,
      gpa,
    },
  };
}

export async function uploadStudentPhoto(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  userId: string,
  input: PhotoUploadInput,
): Promise<{ sha256: string; byteLength: number; mimeType: string }> {
  if (!input.consentGiven) {
    throw AppError.badRequest('CONSENT_REQUIRED', 'Explicit student consent is required to store identity photograph');
  }

  const match = /^data:(image\/(jpeg|jpg|png|webp));base64,(.+)$/.exec(input.dataUrl);
  if (!match || !match[1] || !match[3]) {
    throw AppError.badRequest('INVALID_IMAGE', 'Provided image must be a valid base64 data URL (JPEG, PNG, or WebP)');
  }

  const mimeType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const buffer = Buffer.from(match[3], 'base64');

  // Enforce max size (2 MB)
  if (buffer.length > 2 * 1024 * 1024) {
    throw AppError.badRequest('IMAGE_TOO_LARGE', 'Photograph must not exceed 2 MB');
  }

  const sha256 = sha256Hex(buffer);
  const storage = getDocumentStorage();
  const key = `students_${userId}_photo.${ext}`;

  await storage.putObject(tenantId, 'documents', key, buffer, mimeType);

  await trx('student_documents')
    .insert({
      tenant_id: tenantId,
      user_id: userId,
      kind: 'PHOTO',
      blob_ref: key,
      sha256,
      mime_type: mimeType,
      byte_length: buffer.length,
      metadata: { consentGiven: true, consentTimestamp: deps.clock.now().toISOString() },
      updated_at: trx.fn.now(),
    })
    .onConflict(['tenant_id', 'user_id', 'kind'])
    .merge({
      blob_ref: key,
      sha256,
      mime_type: mimeType,
      byte_length: buffer.length,
      metadata: { consentGiven: true, consentTimestamp: deps.clock.now().toISOString() },
      updated_at: trx.fn.now(),
    });

  await trx('student_profiles')
    .where({ tenant_id: tenantId, user_id: userId })
    .update({ photo_object_ref: key, updated_at: trx.fn.now() });

  await audit(trx, {
    tenantId,
    actorType: 'USER',
    actorId: userId,
    action: 'student.photo_uploaded',
    entityType: 'user',
    entityId: userId,
    metadata: { sha256, byteLength: buffer.length, mimeType },
  });

  return { sha256, byteLength: buffer.length, mimeType };
}

export async function getStudentPhoto(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  userId: string,
): Promise<{ data: Buffer; mimeType: string; sha256: string }> {
  const doc = await trx('student_documents')
    .where({ tenant_id: tenantId, user_id: userId, kind: 'PHOTO' })
    .first();
  if (!doc) throw AppError.notFound('PHOTO_NOT_FOUND', 'Student photograph not found');

  const storage = getDocumentStorage();
  const res = await storage.getObject(tenantId, 'documents', doc.blob_ref);
  if (!res) throw AppError.notFound('PHOTO_NOT_FOUND', 'Photograph file not found in storage');

  return { data: res.data, mimeType: doc.mime_type, sha256: doc.sha256 };
}

export function computeStudentVerificationHash(tenantId: string, userId: string, registerNumber: string): string {
  return sha256Hex(`smru:student:${tenantId}:${userId}:${registerNumber.trim().toUpperCase()}`);
}

export async function getIdCardData(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  userId: string,
  host: string,
): Promise<IdCardVerificationData & { qrDataUrl: string }> {
  const tenant = await trx('tenants').where('id', tenantId).first('name');
  const user = await trx('users').where({ tenant_id: tenantId, id: userId }).first('full_name');
  if (!user) throw AppError.notFound('STUDENT_NOT_FOUND', 'Student not found');

  const profile = await trx('student_profiles').where({ tenant_id: tenantId, user_id: userId }).first();
  if (!profile || !profile.register_number) {
    throw AppError.badRequest('INCOMPLETE_PROFILE', 'Student register number is required for ID card generation');
  }

  const [dept, prog, photo] = await Promise.all([
    profile.department_id ? trx('departments').where({ tenant_id: tenantId, id: profile.department_id }).first('code', 'name') : null,
    profile.programme_id ? trx('programmes').where({ tenant_id: tenantId, id: profile.programme_id }).first('code', 'name') : null,
    trx('student_documents').where({ tenant_id: tenantId, user_id: userId, kind: 'PHOTO' }).first('id'),
  ]);

  const hash = computeStudentVerificationHash(tenantId, userId, profile.register_number);
  const verifyUrl = `https://${host}/student/verify-student/${hash}`;
  const qrDataUrl = await generateQrDataUrl(verifyUrl);

  return {
    valid: true,
    tenantName: tenant?.name ?? "St. Mary's University",
    fullName: user.full_name,
    registerNumber: profile.register_number,
    departmentCode: dept?.code ?? null,
    departmentName: dept?.name ?? null,
    programmeCode: prog?.code ?? null,
    programmeName: prog?.name ?? null,
    currentSemester: profile.current_semester ?? null,
    photoAvailable: !!photo,
    issuedAt: deps.clock.now().toISOString(),
    qrDataUrl,
  };
}

export async function verifyStudentByHash(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  hash: string,
): Promise<IdCardVerificationData> {
  const tenant = await trx('tenants').where('id', tenantId).first('name');
  const profiles = await trx('student_profiles as sp')
    .join('users as u', 'u.id', 'sp.user_id')
    .leftJoin('departments as d', 'd.id', 'sp.department_id')
    .leftJoin('programmes as p', 'p.id', 'sp.programme_id')
    .where('sp.tenant_id', tenantId)
    .whereNotNull('sp.register_number')
    .select(
      'sp.user_id as userId',
      'u.full_name as fullName',
      'sp.register_number as registerNumber',
      'sp.current_semester as currentSemester',
      'd.code as departmentCode',
      'd.name as departmentName',
      'p.code as programmeCode',
      'p.name as programmeName',
      'sp.photo_object_ref as photoRef',
    );

  const matched = profiles.find(
    (p) => computeStudentVerificationHash(tenantId, p.userId, p.registerNumber) === hash,
  );

  if (!matched) {
    throw AppError.notFound('STUDENT_VERIFICATION_FAILED', 'No matching enrolled student identity record found');
  }

  return {
    valid: true,
    tenantName: tenant?.name ?? "St. Mary's University",
    fullName: matched.fullName,
    registerNumber: matched.registerNumber,
    departmentCode: matched.departmentCode,
    departmentName: matched.departmentName,
    programmeCode: matched.programmeCode,
    programmeName: matched.programmeName,
    currentSemester: matched.currentSemester,
    photoAvailable: !!matched.photoRef,
    issuedAt: deps.clock.now().toISOString(),
  };
}
