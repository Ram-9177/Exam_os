import { useState, useMemo } from 'react';
import { useAuth } from '@/lib/auth';
import {
  EmptyState,
  PageTitle,
  Skeleton,
  Table,
  Badge,
  Select,
  type Column,
} from '@/ui';
import {
  useDepartmentAnalytics,
  useOverviewAnalytics,
} from './api';
import type { DepartmentAnalyticsData } from '@examos/contracts';

type ExamRollupItem = DepartmentAnalyticsData['examRollups'][number];
type SemesterRollupItem = DepartmentAnalyticsData['semesterRollups'][number];

export function AnalyticsPage() {
  const { me, hasRole } = useAuth();

  // Find department scope if assigned to HOD
  const hodGrant = useMemo(() => {
    return me?.grants.find((g) => g.role === 'HOD' && g.scopeType === 'DEPARTMENT' && g.scopeId);
  }, [me]);

  const overviewQuery = useOverviewAnalytics();
  const overviewDepts = overviewQuery.data?.overview?.departments ?? [];

  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(() => {
    if (hodGrant?.scopeId) return hodGrant.scopeId;
    return null;
  });

  const effectiveDeptId = selectedDeptId || hodGrant?.scopeId || (overviewDepts.length > 0 ? overviewDepts[0]?.id ?? null : null);

  const deptQuery = useDepartmentAnalytics(effectiveDeptId);
  const analytics = deptQuery.data?.analytics;

  const isHodOnly = hasRole('HOD') && !hasRole('CONTROLLER', 'EXAM_CELL_OPERATOR', 'SYSTEM_ADMIN');

  const examColumns: Column<ExamRollupItem>[] = [
    {
      key: 'exam',
      header: 'Exam',
      render: (r) => (
        <div>
          <p className="font-medium text-ink">{r.examTitle}</p>
          <p className="text-xs text-ink-2 font-mono">{r.examCode} · {r.examType}</p>
        </div>
      ),
    },
    {
      key: 'candidates',
      header: 'Candidates',
      align: 'right',
      render: (r) => <span className="font-mono tabular">{r.candidateCount}</span>,
    },
    {
      key: 'marks',
      header: 'Score Range',
      align: 'right',
      render: (r) => (
        <span className="font-mono tabular text-xs">
          {r.lowestMarks} - {r.highestMarks} (avg: {r.avgMarks}) / {r.maxMarks}
        </span>
      ),
    },
    {
      key: 'passRate',
      header: 'Pass Rate',
      align: 'right',
      render: (r) => (
        <Badge tone={r.passRate >= 75 ? 'ready' : r.passRate >= 50 ? 'accent' : 'fix'}>
          {r.passRate.toFixed(1)}%
        </Badge>
      ),
    },
  ];

  const semesterColumns: Column<SemesterRollupItem>[] = [
    {
      key: 'term',
      header: 'Academic Term',
      render: (r) => (
        <span className="font-medium text-ink">
          {r.academicYear} {r.semester ? `· Semester ${r.semester}` : ''}
        </span>
      ),
    },
    {
      key: 'students',
      header: 'Students Assessed',
      align: 'right',
      render: (r) => <span className="font-mono tabular">{r.studentCount}</span>,
    },
    {
      key: 'exams',
      header: 'Exams Conducted',
      align: 'right',
      render: (r) => <span className="font-mono tabular">{r.examsCount}</span>,
    },
    {
      key: 'avg',
      header: 'Average Score',
      align: 'right',
      render: (r) => <span className="font-mono tabular">{r.avgPercentage.toFixed(1)}%</span>,
    },
    {
      key: 'pass',
      header: 'Pass Rate',
      align: 'right',
      render: (r) => (
        <Badge tone={r.passRate >= 75 ? 'ready' : r.passRate >= 50 ? 'accent' : 'fix'}>
          {r.passRate.toFixed(1)}%
        </Badge>
      ),
    },
  ];

  return (
    <div className="max-w-6xl space-y-10">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <PageTitle
          title="Academic Analytics"
          lede="Department performance intelligence and grade distributions computed from published examination records."
        />

        {/* Department Switcher for multi-department staff */}
        {!isHodOnly && overviewDepts.length > 0 ? (
          <div className="w-72">
            <label htmlFor="dept-select" className="text-xs font-medium text-ink-3 uppercase block mb-1">
              Select Department
            </label>
            <select
              id="dept-select"
              value={effectiveDeptId ?? ''}
              onChange={(e) => setSelectedDeptId(e.target.value)}
              className="w-full text-sm rounded-md border border-rule bg-sheet px-3 py-2 text-ink"
            >
              {overviewDepts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.code})
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {deptQuery.isLoading ? (
        <div className="space-y-6">
          <Skeleton lines={4} />
          <Skeleton lines={8} />
        </div>
      ) : deptQuery.isError || !analytics ? (
        <EmptyState title="Department analytics unavailable">
          No records found or your account does not have authorization to view analytics for this department.
        </EmptyState>
      ) : (
        <>
          {/* Department Header */}
          <div className="sheet p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <span className="text-xs text-ink-3 uppercase tracking-wider block font-medium">Department</span>
              <h2 className="text-xl font-serif text-ink font-bold mt-0.5">
                {analytics.department.name} ({analytics.department.code})
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone="ready">Authorized Scope</Badge>
              <span className="text-xs text-ink-3 font-mono">Academic Records Only</span>
            </div>
          </div>

          {/* Metric KPI Cards */}
          <section aria-labelledby="kpi-heading" className="space-y-3">
            <h3 id="kpi-heading" className="text-sm font-semibold uppercase tracking-wider text-ink-2">
              Cumulative Department Performance
            </h3>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-px bg-rule border border-rule rounded-md overflow-hidden">
              <div className="bg-sheet p-4 text-center">
                <span className="text-xs text-ink-3 uppercase block font-medium">Students</span>
                <span className="text-2xl font-serif text-ink mt-1 block font-semibold">
                  {analytics.summary.totalStudents}
                </span>
              </div>
              <div className="bg-sheet p-4 text-center">
                <span className="text-xs text-ink-3 uppercase block font-medium">Total Exams</span>
                <span className="text-2xl font-serif text-ink mt-1 block font-semibold">
                  {analytics.summary.totalExams}
                </span>
              </div>
              <div className="bg-sheet p-4 text-center">
                <span className="text-xs text-ink-3 uppercase block font-medium">Published Results</span>
                <span className="text-2xl font-mono text-ink mt-1 block">
                  {analytics.summary.totalPublishedResults}
                </span>
              </div>
              <div className="bg-sheet p-4 text-center">
                <span className="text-xs text-ink-3 uppercase block font-medium">Department Average</span>
                <span className="text-2xl font-mono text-ink mt-1 block font-semibold">
                  {analytics.summary.avgPercentage.toFixed(1)}%
                </span>
              </div>
              <div className="bg-sheet p-4 text-center">
                <span className="text-xs text-ink-3 uppercase block font-medium">Pass Rate</span>
                <span className="text-2xl font-mono text-ready mt-1 block font-bold">
                  {analytics.summary.passRate.toFixed(1)}%
                </span>
              </div>
            </div>
          </section>

          {/* Semester-wise Academic Rollups */}
          <section aria-labelledby="semesters-heading" className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 id="semesters-heading" className="text-base font-serif font-semibold text-ink">
                Semester Rollups
              </h3>
              <span className="text-xs text-ink-3">
                {analytics.semesterRollups.length} terms recorded
              </span>
            </div>

            {analytics.semesterRollups.length === 0 ? (
              <div className="sheet p-6 text-center text-ink-2 text-sm">
                No semester rollups have been recorded yet.
              </div>
            ) : (
              <Table
                caption="Semester performance rollups"
                columns={semesterColumns}
                rows={analytics.semesterRollups}
                rowKey={(r) => `${r.academicYear}-${r.semester}`}
              />
            )}
          </section>

          {/* Exam-wise Course Distribution */}
          <section aria-labelledby="exams-heading" className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 id="exams-heading" className="text-base font-serif font-semibold text-ink">
                Exam Course Distribution & Pass Analytics
              </h3>
              <span className="text-xs text-ink-3">
                {analytics.examRollups.length} published exams
              </span>
            </div>

            {analytics.examRollups.length === 0 ? (
              <div className="sheet p-6 text-center text-ink-2 text-sm">
                No course results have been published for this department.
              </div>
            ) : (
              <Table
                caption="Exam-wise performance metrics"
                columns={examColumns}
                rows={analytics.examRollups}
                rowKey={(r) => r.examId}
              />
            )}
          </section>

          {/* Strict Privacy Non-Negotiable Callout */}
          <div className="p-4 rounded-md border border-rule bg-sheet-2 text-xs text-ink-2 flex items-center gap-3">
            <div className="p-2 rounded bg-ready-soft text-ready shrink-0 font-bold">
              ✓
            </div>
            <div>
              <span className="font-semibold text-ink block">Privacy & Integrity Assurance</span>
              This analytics console accesses only official, Controller-published student examination grades. Proctoring observations, invigilation alerts, and device telemetry remain sealed and strictly segregated per university governance policy.
            </div>
          </div>
        </>
      )}
    </div>
  );
}

