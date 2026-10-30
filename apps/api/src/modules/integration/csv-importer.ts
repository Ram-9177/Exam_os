import type { Knex } from '@examos/db';
import {
  type Person,
  type AcademicUnit,
  type Course,
  type Enrollment,
  type RosterBatchResponse,
  PersonSchema,
  AcademicUnitSchema,
  CourseSchema,
  EnrollmentSchema,
} from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { upsertPersons, upsertAcademicUnits, upsertCourses, upsertEnrollments, type RosterActor } from './roster.js';
import { AppError } from '../../lib/errors.js';

export function parseCsv(csvText: string): Array<Record<string, string>> {
  const clean = csvText.replace(/^\uFEFF/, '').trim();
  if (!clean) return [];

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let insideQuotes = false;

  let i = 0;
  while (i < clean.length) {
    const char = clean[i];
    const nextChar = clean[i + 1];

    if (insideQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          currentField += '"';
          i += 2;
          continue;
        } else {
          insideQuotes = false;
          i++;
          continue;
        }
      } else {
        currentField += char;
        i++;
        continue;
      }
    } else {
      if (char === '"') {
        insideQuotes = true;
        i++;
        continue;
      } else if (char === ',' || char === '\t' || char === ';') {
        currentRow.push(currentField.trim());
        currentField = '';
        i++;
        continue;
      } else if (char === '\r') {
        if (nextChar === '\n') {
          i += 2;
        } else {
          i++;
        }
        currentRow.push(currentField.trim());
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
        continue;
      } else if (char === '\n') {
        currentRow.push(currentField.trim());
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
        i++;
        continue;
      } else {
        currentField += char;
        i++;
        continue;
      }
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    rows.push(currentRow);
  }

  if (rows.length < 2) return [];

  const headerRow = rows[0]!;
  const normalizedHeaders = headerRow.map((h) =>
    h
      .trim()
      .replace(/[\s_-]+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase())
      .replace(/^[A-Z]/, (c) => c.toLowerCase()),
  );

  const parsedObjects: Array<Record<string, string>> = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    if (row.length === 1 && row[0] === '') continue; // skip blank line
    const obj: Record<string, string> = {};
    for (let c = 0; c < normalizedHeaders.length; c++) {
      const key = normalizedHeaders[c]!;
      if (key) {
        obj[key] = row[c] ?? '';
      }
    }
    parsedObjects.push(obj);
  }

  return parsedObjects;
}

export function generateTemplate(entity: 'PERSON' | 'ACADEMIC_UNIT' | 'COURSE' | 'ENROLLMENT'): string {
  switch (entity) {
    case 'PERSON':
      return [
        'externalId,email,fullName,kind,status,departmentCode,programmeCode,admissionBatch,currentSemester,section,preferredLanguage,registerNumber',
        'STU-2026-001,alice.kumar@student.smru.edu.in,Alice Kumar,STUDENT,ACTIVE,CSE,BTECH-CSE,2024,4,A,en,24BCSE001',
        'STU-2026-002,bob.sharma@student.smru.edu.in,Bob Sharma,STUDENT,ACTIVE,CSE,BTECH-CSE,2024,4,A,en,24BCSE002',
        'STAFF-2026-001,prof.rao@smru.edu.in,Prof. K. V. Rao,STAFF,ACTIVE,CSE,,,,,,',
      ].join('\n');
    case 'ACADEMIC_UNIT':
      return [
        'code,name,kind,parentCode,status',
        'CSE,Computer Science and Engineering,DEPARTMENT,SOET,ACTIVE',
        'ECE,Electronics and Communication Engineering,DEPARTMENT,SOET,ACTIVE',
        'BTECH-CSE,B.Tech Computer Science and Engineering,PROGRAMME,CSE,ACTIVE',
      ].join('\n');
    case 'COURSE':
      return [
        'code,name,departmentCode,credits,status',
        'CS201,Data Structures and Algorithms,CSE,4,ACTIVE',
        'CS202,Database Management Systems,CSE,4,ACTIVE',
        'CS203,Operating Systems,CSE,4,ACTIVE',
      ].join('\n');
    case 'ENROLLMENT':
      return [
        'studentExternalId,courseCode,academicYear,term,section,eligibilityStatus',
        'STU-2026-001,CS201,2025-26,SEM_2,A,ELIGIBLE',
        'STU-2026-002,CS201,2025-26,SEM_2,A,ELIGIBLE',
      ].join('\n');
  }
}

export interface PreviewOutcome {
  index: number;
  externalId: string;
  outcome: 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'REJECTED' | 'IDENTITY_CONFLICT';
  code?: string;
  message?: string;
  data: Record<string, unknown>;
}

export interface ImportPreviewResponse {
  entity: string;
  total: number;
  summary: {
    created: number;
    updated: number;
    unchanged: number;
    rejected: number;
    identityConflicts: number;
  };
  sampleRows: PreviewOutcome[];
}

export async function previewRosterImport(
  _deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  entity: 'PERSON' | 'ACADEMIC_UNIT' | 'COURSE' | 'ENROLLMENT',
  csvContent: string,
  mode: 'UPSERT' | 'CREATE_ONLY' | 'UPDATE_ONLY' = 'UPSERT',
  provider = 'xlsx',
): Promise<ImportPreviewResponse> {
  const records = parseCsv(csvContent);
  if (!records.length) {
    throw AppError.badRequest('CSV_EMPTY', 'The uploaded CSV file contains no data rows');
  }

  const outcomes: PreviewOutcome[] = [];

  for (let i = 0; i < records.length; i++) {
    const raw = records[i]!;
    try {
      if (entity === 'PERSON') {
        const parsed = PersonSchema.safeParse({
          externalId: raw['externalId'],
          email: raw['email'],
          fullName: raw['fullName'],
          kind: raw['kind'] || 'STUDENT',
          status: raw['status'] || 'ACTIVE',
          departmentCode: raw['departmentCode'] || undefined,
          programmeCode: raw['programmeCode'] || undefined,
          admissionBatch: raw['admissionBatch'] || undefined,
          currentSemester: raw['currentSemester'] ? Number(raw['currentSemester']) : undefined,
          section: raw['section'] || undefined,
          preferredLanguage: raw['preferredLanguage'] || undefined,
          attributes: raw['registerNumber'] ? { registerNumber: raw['registerNumber'] } : undefined,
        });

        if (!parsed.success) {
          outcomes.push({
            index: i,
            externalId: raw['externalId'] || `row-${i + 1}`,
            outcome: 'REJECTED',
            code: 'VALIDATION_FAILED',
            message: parsed.error.issues.map((iss) => `${iss.path.join('.')}: ${iss.message}`).join('; '),
            data: raw,
          });
          continue;
        }

        const p = parsed.data;
        const identity = await trx('external_identities')
          .where({ tenant_id: tenantId, provider, external_id: p.externalId })
          .first();
        const emailOwner = await trx('users')
          .where({ tenant_id: tenantId, email: p.email })
          .first('id');

        if (identity) {
          if (mode === 'CREATE_ONLY') {
            outcomes.push({ index: i, externalId: p.externalId, outcome: 'UNCHANGED', code: 'EXISTS', data: p as Record<string, unknown> });
          } else if (emailOwner && emailOwner.id !== identity.user_id) {
            outcomes.push({
              index: i,
              externalId: p.externalId,
              outcome: 'IDENTITY_CONFLICT',
              code: 'EMAIL_BELONGS_TO_OTHER_IDENTITY',
              message: `Email ${p.email} is attached to another user`,
              data: p as Record<string, unknown>,
            });
          } else {
            outcomes.push({ index: i, externalId: p.externalId, outcome: 'UPDATED', data: p as Record<string, unknown> });
          }
        } else {
          if (mode === 'UPDATE_ONLY') {
            outcomes.push({ index: i, externalId: p.externalId, outcome: 'REJECTED', code: 'NOT_FOUND', message: 'Person does not exist', data: p as Record<string, unknown> });
          } else if (emailOwner) {
            outcomes.push({
              index: i,
              externalId: p.externalId,
              outcome: 'IDENTITY_CONFLICT',
              code: 'EMAIL_BELONGS_TO_OTHER_IDENTITY',
              message: `Email ${p.email} already exists with a different external ID`,
              data: p as Record<string, unknown>,
            });
          } else {
            outcomes.push({ index: i, externalId: p.externalId, outcome: 'CREATED', data: p as Record<string, unknown> });
          }
        }
      } else if (entity === 'ACADEMIC_UNIT') {
        const parsed = AcademicUnitSchema.safeParse({
          code: raw['code'],
          name: raw['name'],
          kind: raw['kind'] || 'DEPARTMENT',
          parentCode: raw['parentCode'] || undefined,
          status: raw['status'] || 'ACTIVE',
        });
        if (!parsed.success) {
          outcomes.push({
            index: i,
            externalId: raw['code'] || `row-${i + 1}`,
            outcome: 'REJECTED',
            code: 'VALIDATION_FAILED',
            message: parsed.error.issues.map((iss) => `${iss.path.join('.')}: ${iss.message}`).join('; '),
            data: raw,
          });
          continue;
        }
        const u = parsed.data;
        const table = u.kind === 'DEPARTMENT' ? 'departments' : 'programmes';
        const existing = await trx(table).where({ tenant_id: tenantId, code: u.code }).first();
        if (existing) {
          outcomes.push({ index: i, externalId: u.code, outcome: mode === 'CREATE_ONLY' ? 'UNCHANGED' : 'UPDATED', data: u as Record<string, unknown> });
        } else {
          outcomes.push({ index: i, externalId: u.code, outcome: mode === 'UPDATE_ONLY' ? 'REJECTED' : 'CREATED', data: u as Record<string, unknown> });
        }
      } else if (entity === 'COURSE') {
        const parsed = CourseSchema.safeParse({
          code: raw['code'],
          name: raw['name'],
          departmentCode: raw['departmentCode'],
          credits: raw['credits'] ? Number(raw['credits']) : undefined,
          status: raw['status'] || 'ACTIVE',
        });
        if (!parsed.success) {
          outcomes.push({
            index: i,
            externalId: raw['code'] || `row-${i + 1}`,
            outcome: 'REJECTED',
            code: 'VALIDATION_FAILED',
            message: parsed.error.issues.map((iss) => `${iss.path.join('.')}: ${iss.message}`).join('; '),
            data: raw,
          });
          continue;
        }
        const c = parsed.data;
        const dept = await trx('departments').where({ tenant_id: tenantId, code: c.departmentCode }).first('id');
        if (!dept) {
          outcomes.push({ index: i, externalId: c.code, outcome: 'REJECTED', code: 'DEPARTMENT_NOT_FOUND', message: `Department ${c.departmentCode} not found`, data: c as Record<string, unknown> });
          continue;
        }
        const existing = await trx('courses').where({ tenant_id: tenantId, code: c.code }).first();
        outcomes.push({ index: i, externalId: c.code, outcome: existing ? (mode === 'CREATE_ONLY' ? 'UNCHANGED' : 'UPDATED') : (mode === 'UPDATE_ONLY' ? 'REJECTED' : 'CREATED'), data: c as Record<string, unknown> });
      } else if (entity === 'ENROLLMENT') {
        const parsed = EnrollmentSchema.safeParse({
          studentExternalId: raw['studentExternalId'],
          courseCode: raw['courseCode'],
          academicYear: raw['academicYear'],
          term: raw['term'],
          section: raw['section'] || undefined,
          eligibilityStatus: raw['eligibilityStatus'] || 'ELIGIBLE',
        });
        if (!parsed.success) {
          outcomes.push({
            index: i,
            externalId: raw['studentExternalId'] || `row-${i + 1}`,
            outcome: 'REJECTED',
            code: 'VALIDATION_FAILED',
            message: parsed.error.issues.map((iss) => `${iss.path.join('.')}: ${iss.message}`).join('; '),
            data: raw,
          });
          continue;
        }
        const e = parsed.data;
        const identity = await trx('external_identities').where({ tenant_id: tenantId, provider, external_id: e.studentExternalId }).first('user_id');
        if (!identity) {
          outcomes.push({ index: i, externalId: e.studentExternalId, outcome: 'REJECTED', code: 'STUDENT_NOT_FOUND', message: `Student ${e.studentExternalId} must be synced before enrollment`, data: e as Record<string, unknown> });
          continue;
        }
        const course = await trx('courses').where({ tenant_id: tenantId, code: e.courseCode }).first('id');
        if (!course) {
          outcomes.push({ index: i, externalId: e.studentExternalId, outcome: 'REJECTED', code: 'COURSE_NOT_FOUND', message: `Course ${e.courseCode} not found`, data: e as Record<string, unknown> });
          continue;
        }
        const existing = await trx('course_enrollments').where({ tenant_id: tenantId, user_id: identity.user_id, course_id: course.id, academic_year: e.academicYear, term: e.term }).first();
        outcomes.push({ index: i, externalId: e.studentExternalId, outcome: existing ? (mode === 'CREATE_ONLY' ? 'UNCHANGED' : 'UPDATED') : (mode === 'UPDATE_ONLY' ? 'REJECTED' : 'CREATED'), data: e as Record<string, unknown> });
      }
    } catch (err) {
      outcomes.push({
        index: i,
        externalId: raw['externalId'] || raw['code'] || `row-${i + 1}`,
        outcome: 'REJECTED',
        code: 'ERROR',
        message: err instanceof Error ? err.message : 'Unknown parsing error',
        data: raw,
      });
    }
  }

  const summary = {
    created: outcomes.filter((o) => o.outcome === 'CREATED').length,
    updated: outcomes.filter((o) => o.outcome === 'UPDATED').length,
    unchanged: outcomes.filter((o) => o.outcome === 'UNCHANGED').length,
    rejected: outcomes.filter((o) => o.outcome === 'REJECTED').length,
    identityConflicts: outcomes.filter((o) => o.outcome === 'IDENTITY_CONFLICT').length,
  };

  return {
    entity,
    total: records.length,
    summary,
    sampleRows: outcomes.slice(0, 50),
  };
}

export async function executeRosterImport(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  entity: 'PERSON' | 'ACADEMIC_UNIT' | 'COURSE' | 'ENROLLMENT',
  csvContent: string,
  mode: 'UPSERT' | 'CREATE_ONLY' | 'UPDATE_ONLY' = 'UPSERT',
  provider = 'xlsx',
  actorUserId?: string | null,
  sourceLabel?: string,
): Promise<RosterBatchResponse> {
  const records = parseCsv(csvContent);
  if (!records.length) {
    throw AppError.badRequest('CSV_EMPTY', 'The uploaded CSV file contains no data rows');
  }

  const actor: RosterActor = {
    tenantId,
    provider,
    source: 'XLSX',
    actorUserId: actorUserId ?? null,
    sourceLabel: sourceLabel ?? `XLSX Import (${entity})`,
  };

  if (entity === 'PERSON') {
    const rows: Person[] = [];
    for (const raw of records) {
      rows.push(
        PersonSchema.parse({
          externalId: raw['externalId'],
          email: raw['email'],
          fullName: raw['fullName'],
          kind: raw['kind'] || 'STUDENT',
          status: raw['status'] || 'ACTIVE',
          departmentCode: raw['departmentCode'] || undefined,
          programmeCode: raw['programmeCode'] || undefined,
          admissionBatch: raw['admissionBatch'] || undefined,
          currentSemester: raw['currentSemester'] ? Number(raw['currentSemester']) : undefined,
          section: raw['section'] || undefined,
          preferredLanguage: raw['preferredLanguage'] || undefined,
          attributes: raw['registerNumber'] ? { registerNumber: raw['registerNumber'] } : undefined,
        }),
      );
    }
    return upsertPersons(deps, trx, actor, rows, mode);
  }

  if (entity === 'ACADEMIC_UNIT') {
    const rows: AcademicUnit[] = [];
    for (const raw of records) {
      rows.push(
        AcademicUnitSchema.parse({
          code: raw['code'],
          name: raw['name'],
          kind: raw['kind'] || 'DEPARTMENT',
          parentCode: raw['parentCode'] || undefined,
          status: raw['status'] || 'ACTIVE',
        }),
      );
    }
    return upsertAcademicUnits(trx, actor, rows, mode);
  }

  if (entity === 'COURSE') {
    const rows: Course[] = [];
    for (const raw of records) {
      rows.push(
        CourseSchema.parse({
          code: raw['code'],
          name: raw['name'],
          departmentCode: raw['departmentCode'],
          credits: raw['credits'] ? Number(raw['credits']) : undefined,
          status: raw['status'] || 'ACTIVE',
        }),
      );
    }
    return upsertCourses(trx, actor, rows, mode);
  }

  if (entity === 'ENROLLMENT') {
    const rows: Enrollment[] = [];
    for (const raw of records) {
      rows.push(
        EnrollmentSchema.parse({
          studentExternalId: raw['studentExternalId'],
          courseCode: raw['courseCode'],
          academicYear: raw['academicYear'],
          term: raw['term'],
          section: raw['section'] || undefined,
          eligibilityStatus: raw['eligibilityStatus'] || 'ELIGIBLE',
        }),
      );
    }
    return upsertEnrollments(trx, actor, rows, mode);
  }

  throw AppError.badRequest('INVALID_ENTITY', `Unsupported entity type: ${entity}`);
}

