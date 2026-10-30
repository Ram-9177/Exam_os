import type { Knex } from '@examos/db';
import { AppError } from '../../lib/errors.js';
import type { DepartmentAnalyticsData } from '@examos/contracts';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function getDepartmentAnalytics(
  trx: Knex.Transaction,
  tenantId: string,
  departmentId: string,
): Promise<DepartmentAnalyticsData> {
  const dept = await trx('departments')
    .where({ tenant_id: tenantId, id: departmentId })
    .first('id', 'code', 'name');
  if (!dept) throw AppError.notFound('DEPARTMENT_NOT_FOUND', 'Department not found');

  const studentCountRow = await trx('student_profiles')
    .where({ tenant_id: tenantId, department_id: departmentId })
    .count<{ count: string }>('id as count')
    .first();
  const totalStudents = Number(studentCountRow?.count ?? 0);

  // Note: STRICT PROCTORING DATA PRIVACY INVARIANT:
  // Analytics queries ONLY academic and published results ledger.
  // Never query or join proctor_incidents, proctor_warnings, or attempt_event_log.
  const records = await trx('student_exam_records as ser')
    .join('exams as e', 'e.id', 'ser.exam_id')
    .join('student_profiles as sp', 'sp.user_id', 'ser.user_id')
    .where({ 'ser.tenant_id': tenantId, 'sp.department_id': departmentId })
    .whereNull('ser.superseded_at')
    .select(
      'ser.id as recordId',
      'ser.user_id as userId',
      'ser.exam_id as examId',
      'e.code as examCode',
      'e.title as examTitle',
      'ser.exam_type as examType',
      'ser.academic_year as academicYear',
      'ser.semester as semester',
      'ser.marks as marks',
      'ser.max_marks as maxMarks',
      'ser.grade as grade',
    );

  const totalPublishedResults = records.length;
  const distinctExams = new Set(records.map((r) => r.examId));
  const totalExams = distinctExams.size;

  const totalMarks = records.reduce((sum, r) => sum + Number(r.marks), 0);
  const totalMaxMarks = records.reduce((sum, r) => sum + Number(r.maxMarks), 0);
  const avgPercentage = totalMaxMarks > 0 ? round2((totalMarks / totalMaxMarks) * 100) : 0;

  // Passing threshold: marks >= 40% of max_marks and grade != 'F'
  const passCount = records.filter(
    (r) => Number(r.marks) >= 0.4 * Number(r.maxMarks) && r.grade !== 'F',
  ).length;
  const failCount = totalPublishedResults - passCount;
  const passRate = totalPublishedResults > 0 ? round2((passCount / totalPublishedResults) * 100) : 0;

  // Semester rollups
  const semesterMap = new Map<string, typeof records>();
  for (const r of records) {
    const key = `${r.academicYear ?? '—'}::${r.semester ?? 0}`;
    const list = semesterMap.get(key) ?? [];
    list.push(r);
    semesterMap.set(key, list);
  }

  const semesterRollups = Array.from(semesterMap.entries()).map(([key, group]) => {
    const [academicYear, semStr] = key.split('::');
    const sem = semStr ? Number(semStr) : null;
    const gMarks = group.reduce((sum, r) => sum + Number(r.marks), 0);
    const gMax = group.reduce((sum, r) => sum + Number(r.maxMarks), 0);
    const gAvgPct = gMax > 0 ? round2((gMarks / gMax) * 100) : 0;
    const gPass = group.filter(
      (r) => Number(r.marks) >= 0.4 * Number(r.maxMarks) && r.grade !== 'F',
    ).length;
    const gPassRate = group.length > 0 ? round2((gPass / group.length) * 100) : 0;
    const students = new Set(group.map((r) => r.userId)).size;
    const exams = new Set(group.map((r) => r.examId)).size;

    return {
      academicYear: academicYear ?? '—',
      semester: sem,
      examsCount: exams,
      studentCount: students,
      avgPercentage: gAvgPct,
      passRate: gPassRate,
    };
  });

  // Exam rollups
  const examMap = new Map<string, typeof records>();
  for (const r of records) {
    const list = examMap.get(r.examId) ?? [];
    list.push(r);
    examMap.set(r.examId, list);
  }

  const examRollups = Array.from(examMap.entries()).map(([examId, group]) => {
    const first = group[0]!;
    const maxMarks = Number(first.maxMarks);
    const marksArr = group.map((r) => Number(r.marks));
    const sum = marksArr.reduce((a, b) => a + b, 0);
    const avg = round2(sum / marksArr.length);
    const highest = Math.max(...marksArr);
    const lowest = Math.min(...marksArr);
    const ePass = group.filter(
      (r) => Number(r.marks) >= 0.4 * maxMarks && r.grade !== 'F',
    ).length;
    const ePassRate = round2((ePass / group.length) * 100);

    return {
      examId,
      examCode: first.examCode,
      examTitle: first.examTitle,
      examType: first.examType,
      maxMarks,
      avgMarks: avg,
      highestMarks: highest,
      lowestMarks: lowest,
      candidateCount: group.length,
      passCount: ePass,
      passRate: ePassRate,
    };
  });

  return {
    department: {
      id: dept.id,
      code: dept.code,
      name: dept.name,
    },
    summary: {
      totalStudents,
      totalExams,
      totalPublishedResults,
      avgPercentage,
      passCount,
      failCount,
      passRate,
    },
    semesterRollups,
    examRollups,
  };
}

export async function getOverviewAnalytics(
  trx: Knex.Transaction,
  tenantId: string,
): Promise<{ departments: DepartmentAnalyticsData[] }> {
  const depts = await trx('departments').where('tenant_id', tenantId).select('id').orderBy('code');
  const results = await Promise.all(
    depts.map((d) => getDepartmentAnalytics(trx, tenantId, d.id)),
  );
  return { departments: results };
}

