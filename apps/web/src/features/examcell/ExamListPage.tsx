import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { EXAM_STATUSES, EXAM_TYPES } from '@examos/contracts';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/time';
import { EXAM_TYPE_LABEL } from '@/features/student/api';
import { Badge, ChevronIcon, EmptyState, Field, LinkButton, PageTitle, Select, Skeleton, StatusChip, TextInput, toneForExam } from '@/ui';
import { EXAM_STATUS_LABEL, useExams, type ExamFilters, type ExamListItem } from './api';

/**
 * Hierarchy first: school → department → exams. A tenant with forty
 * departments never sees one flat list; filters narrow the tree rather than
 * adding columns.
 */
export function ExamListPage() {
  const { me } = useAuth();
  const tz = me?.tenant.timezone ?? 'Asia/Kolkata';
  const [filters, setFilters] = useState<ExamFilters>({});
  const [q, setQ] = useState('');
  const exams = useExams({ ...filters, q: q.trim() || undefined });
  const navigate = useNavigate();

  const list = exams.data?.exams ?? [];
  const options = useMemo(() => {
    const years = new Set<string>();
    const sems = new Set<number>();
    const schools = new Map<string, string>();
    const depts = new Map<string, string>();
    for (const e of list) {
      if (e.academicYear) years.add(e.academicYear);
      if (e.semester) sems.add(e.semester);
      if (e.schoolCode) schools.set(e.schoolCode, e.schoolName ?? e.schoolCode);
      if (e.departmentCode) depts.set(e.departmentCode, e.departmentName ?? e.departmentCode);
    }
    return { years: [...years].sort(), sems: [...sems].sort((a, b) => a - b), schools: [...schools.entries()], depts: [...depts.entries()] };
  }, [list]);

  const tree = useMemo(() => {
    const bySchool = new Map<string, { name: string; depts: Map<string, { name: string; exams: ExamListItem[] }> }>();
    for (const e of list) {
      const sk = e.schoolCode ?? '—';
      const sName = e.schoolName ?? 'No school';
      const dk = e.departmentCode ?? '—';
      const dName = e.departmentName ?? 'No department';
      let s = bySchool.get(sk);
      if (!s) {
        s = { name: sName, depts: new Map() };
        bySchool.set(sk, s);
      }
      let d = s.depts.get(dk);
      if (!d) {
        d = { name: dName, exams: [] };
        s.depts.set(dk, d);
      }
      d.exams.push(e);
    }
    return [...bySchool.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [list]);

  const set = (k: keyof ExamFilters) => (v: string) => setFilters((f) => ({ ...f, [k]: v || undefined }));
  const liveCount = list.filter((e) => e.status === 'LIVE').length;
  const precheckCount = list.filter((e) => e.status === 'PRECHECK').length;

  return (
    <div>
      <PageTitle
        title="Exams"
        lede={liveCount || precheckCount ? `${liveCount} live, ${precheckCount} with the readiness check open.` : 'Every exam the Examination Section runs, by school and department.'}
        actions={
          <LinkButton to="/examcell/exams/new" variant="primary">
            New exam
          </LinkButton>
        }
      />

      <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-8 mb-8" onSubmit={(e) => e.preventDefault()} aria-label="Filters">
        <Field label="Search" className="lg:col-span-2">
          {({ id }) => <TextInput id={id} type="search" placeholder="Title or code" value={q} onChange={(e) => setQ(e.target.value)} />}
        </Field>
        <Field label="Status">
          {({ id }) => (
            <Select id={id} value={filters.status ?? ''} onChange={(e) => set('status')(e.target.value)}>
              <option value="">Any</option>
              {EXAM_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {EXAM_STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Type">
          {({ id }) => (
            <Select id={id} value={filters.examType ?? ''} onChange={(e) => set('examType')(e.target.value)}>
              <option value="">Any</option>
              {EXAM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {EXAM_TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Year">
          {({ id }) => (
            <Select id={id} value={filters.academicYear ?? ''} onChange={(e) => set('academicYear')(e.target.value)}>
              <option value="">Any</option>
              {options.years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Semester">
          {({ id }) => (
            <Select id={id} value={filters.semester ?? ''} onChange={(e) => set('semester')(e.target.value)}>
              <option value="">Any</option>
              {options.sems.map((s) => (
                <option key={s} value={String(s)}>
                  {s}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="School">
          {({ id }) => (
            <Select id={id} value={filters.schoolCode ?? ''} onChange={(e) => set('schoolCode')(e.target.value)}>
              <option value="">Any</option>
              {options.schools.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Department">
          {({ id }) => (
            <Select id={id} value={filters.departmentCode ?? ''} onChange={(e) => set('departmentCode')(e.target.value)}>
              <option value="">Any</option>
              {options.depts.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </form>

      {exams.isLoading ? <Skeleton lines={6} /> : null}
      {exams.isError ? <EmptyState title="The exam list could not be loaded">Reload the page or try again in a moment.</EmptyState> : null}
      {exams.data && list.length === 0 ? (
        <EmptyState title="No exams match" action={<LinkButton to="/examcell/exams/new">Create the first exam</LinkButton>}>
          Clear a filter, or create an exam. Exams need a course from the roster first.
        </EmptyState>
      ) : null}

      <div className="flex flex-col gap-3">
        {tree.map(([schoolCode, school]) => (
          <details key={schoolCode} open className="group sheet">
            <summary className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
              <ChevronIcon className="text-ink-2 group-open:rotate-90 transition-transform" />
              <span className="font-serif text-xl" style={{ fontVariationSettings: "'opsz' 36" }}>
                {school.name}
              </span>
              <span className="text-sm text-ink-2 ml-auto tabular">{[...school.depts.values()].reduce((n, d) => n + d.exams.length, 0)} exams</span>
            </summary>
            <div className="border-t border-rule">
              {[...school.depts.entries()]
                .sort((a, b) => a[1].name.localeCompare(b[1].name))
                .map(([deptCode, dept]) => (
                  <details key={deptCode} open className="group/d border-b border-rule last:border-b-0">
                    <summary className="flex items-center gap-3 pl-10 pr-4 py-2.5 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden text-[15px]">
                      <ChevronIcon size={14} className="text-ink-2 group-open/d:rotate-90 transition-transform" />
                      <span className="font-medium">{dept.name}</span>
                      <span className="text-sm text-ink-2 ml-auto tabular">{dept.exams.length}</span>
                    </summary>
                    <ul className="pb-2">
                      {dept.exams.map((e) => (
                        <li key={e.id}>
                          <button type="button" onClick={() => navigate(`/examcell/exams/${e.id}`)} className="w-full text-left pl-16 pr-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 hover:bg-sheet-2 border-t border-rule/60">
                            <span className="font-mono text-sm text-ink-2 w-28 shrink-0">{e.code}</span>
                            <span className="flex-1 min-w-48 font-medium">{e.title}</span>
                            <Badge>{EXAM_TYPE_LABEL[e.examType]}</Badge>
                            <span className="text-sm text-ink-2 w-56">{formatDateTime(e.windowStartAt, tz)}</span>
                            <StatusChip tone={toneForExam(e.status)} icon={false}>
                              {EXAM_STATUS_LABEL[e.status]}
                            </StatusChip>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </details>
                ))}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
