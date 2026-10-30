import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { EXAM_TYPES, SECURITY_PROFILES } from '@examos/contracts';
import { api, isApiError } from '@/lib/api';
import { EXAM_TYPE_LABEL } from '@/features/student/api';
import { Button, Field, PageTitle, Select, TextArea, TextInput, useToast } from '@/ui';

const PROFILE_HELP: Record<string, string> = {
  PRACTICE: 'Rehearsal only. Identity check, nothing else.',
  BASIC_BROWSER: 'Any modern browser. Identity, eligibility, connection, clock and keyboard checks.',
  SECURE_BYOD: 'Student devices with the approved exam client; adds client, consent and, by default, camera and microphone.',
  MANAGED_ENDPOINT: 'University-managed lab machines with the approved client.',
};

function toIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function ExamNewPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [f, setF] = useState({
    code: '',
    title: '',
    courseCode: '',
    examType: 'SEM_INTERNAL',
    academicYear: '',
    semester: '',
    maxMarks: '',
    securityProfile: 'SECURE_BYOD',
    durationMinutes: '60',
    windowStartAt: '',
    windowEndAt: '',
    warningThreshold: '5',
    policy: '',
  });
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!f.code.trim()) errs['code'] = 'Give the exam a code, like CS301-MID1.';
    if (!f.title.trim()) errs['title'] = 'Give the exam a title.';
    if (!f.courseCode.trim()) errs['courseCode'] = 'The course code must exist in the roster.';
    const start = toIso(f.windowStartAt);
    const end = toIso(f.windowEndAt);
    if (!start) errs['windowStartAt'] = 'Set when the window opens.';
    if (!end) errs['windowEndAt'] = 'Set when the window closes.';
    if (start && end && end <= start) errs['windowEndAt'] = 'The window must close after it opens.';
    if (f.academicYear && !/^\d{4}-\d{2,4}$/.test(f.academicYear)) errs['academicYear'] = 'Use the form 2026-27.';
    let policy: Record<string, unknown> = {};
    if (f.policy.trim()) {
      try {
        const parsed: unknown = JSON.parse(f.policy);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        policy = parsed as Record<string, unknown>;
      } catch {
        errs['policy'] = 'Policy must be a JSON object, for example {"capture":{"webcam_required_for_this_tier":false}}.';
      }
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const out = await api.post<{ examId: string }>(
        '/exams',
        {
          code: f.code.trim(),
          title: f.title.trim(),
          courseCode: f.courseCode.trim(),
          examType: f.examType,
          academicYear: f.academicYear || undefined,
          semester: f.semester ? Number(f.semester) : undefined,
          maxMarks: f.maxMarks ? Number(f.maxMarks) : undefined,
          securityProfile: f.securityProfile,
          durationMinutes: Number(f.durationMinutes),
          windowStartAt: start,
          windowEndAt: end,
          warningThreshold: Number(f.warningThreshold),
          policy,
        },
        { quiet: ['COURSE_NOT_FOUND', 'EXAM_EXISTS', 'WINDOW_INVALID', 'VALIDATION'] },
      );
      toast({ tone: 'success', title: 'Exam created', description: `${f.code.trim()} is in draft.` });
      navigate(`/examcell/exams/${out.examId}`);
    } catch (err) {
      if (isApiError(err, 'COURSE_NOT_FOUND')) setErrors({ courseCode: 'No course with this code in the roster. Sync the roster first.' });
      else if (isApiError(err, 'EXAM_EXISTS')) setErrors({ code: 'An exam with this code already exists.' });
      else if (isApiError(err, 'WINDOW_INVALID')) setErrors({ windowEndAt: 'The window must close after it opens.' });
      else if (isApiError(err) && err.problem.errors?.length) setErrors(Object.fromEntries(err.problem.errors.map((x) => [x.path.replace(/^body\./, ''), x.message])));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-3xl">
      <PageTitle title="New exam" lede="Creates the exam in draft. Allocate students and issue hall tickets from the exam page." />
      <form onSubmit={(e) => void onSubmit(e)} noValidate className="flex flex-col gap-8">
        <section className="sheet p-6 grid gap-4 sm:grid-cols-2">
          <h2 className="sm:col-span-2 text-h3">Identity</h2>
          <Field label="Code" error={errors['code']} required>
            {({ id, describedBy, invalid }) => <TextInput id={id} value={f.code} onChange={(e) => set('code')(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid || undefined} placeholder="CS301-MID1" className="font-mono" />}
          </Field>
          <Field label="Course code" hint="From the roster." error={errors['courseCode']} required>
            {({ id, describedBy, invalid }) => <TextInput id={id} value={f.courseCode} onChange={(e) => set('courseCode')(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid || undefined} placeholder="CS301" className="font-mono" />}
          </Field>
          <Field label="Title" error={errors['title']} required className="sm:col-span-2">
            {({ id, describedBy, invalid }) => <TextInput id={id} value={f.title} onChange={(e) => set('title')(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid || undefined} placeholder="Operating Systems — Mid 1" />}
          </Field>
          <Field label="Type">
            {({ id }) => (
              <Select id={id} value={f.examType} onChange={(e) => set('examType')(e.target.value)}>
                {EXAM_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {EXAM_TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Maximum marks" error={errors['maxMarks']}>
            {({ id, describedBy }) => <TextInput id={id} type="number" min={1} max={1000} value={f.maxMarks} onChange={(e) => set('maxMarks')(e.target.value)} aria-describedby={describedBy} />}
          </Field>
          <Field label="Academic year" hint="Like 2026-27." error={errors['academicYear']}>
            {({ id, describedBy, invalid }) => <TextInput id={id} value={f.academicYear} onChange={(e) => set('academicYear')(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid || undefined} placeholder="2026-27" />}
          </Field>
          <Field label="Semester" error={errors['semester']}>
            {({ id, describedBy }) => <TextInput id={id} type="number" min={1} max={20} value={f.semester} onChange={(e) => set('semester')(e.target.value)} aria-describedby={describedBy} />}
          </Field>
        </section>

        <section className="sheet p-6 grid gap-4 sm:grid-cols-2">
          <h2 className="sm:col-span-2 text-h3">Window and conduct</h2>
          <Field label="Window opens" error={errors['windowStartAt']} required>
            {({ id, describedBy, invalid }) => <TextInput id={id} type="datetime-local" value={f.windowStartAt} onChange={(e) => set('windowStartAt')(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid || undefined} />}
          </Field>
          <Field label="Window closes" error={errors['windowEndAt']} required>
            {({ id, describedBy, invalid }) => <TextInput id={id} type="datetime-local" value={f.windowEndAt} onChange={(e) => set('windowEndAt')(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid || undefined} />}
          </Field>
          <Field label="Duration (minutes)" hint="Per student, from admission. Approved extra time is added per allocation." error={errors['durationMinutes']}>
            {({ id, describedBy }) => <TextInput id={id} type="number" min={5} max={600} value={f.durationMinutes} onChange={(e) => set('durationMinutes')(e.target.value)} aria-describedby={describedBy} />}
          </Field>
          <Field label="Warning threshold" hint="Confirmed warnings in one epoch before an automatic pause." error={errors['warningThreshold']}>
            {({ id, describedBy }) => <TextInput id={id} type="number" min={1} max={20} value={f.warningThreshold} onChange={(e) => set('warningThreshold')(e.target.value)} aria-describedby={describedBy} />}
          </Field>
          <Field label="Security profile" hint={PROFILE_HELP[f.securityProfile]} className="sm:col-span-2">
            {({ id, describedBy }) => (
              <Select id={id} value={f.securityProfile} onChange={(e) => set('securityProfile')(e.target.value)} aria-describedby={describedBy}>
                {SECURITY_PROFILES.map((p) => (
                  <option key={p} value={p}>
                    {p.replace(/_/g, ' ').toLowerCase()}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Policy (JSON, optional)" hint='Keys the readiness check reads: capture.webcam_required_for_this_tier, capture.mic_required_for_this_tier, allowedClientBuilds, sebConfigKey, monitoringNotice, grading.bands.' error={errors['policy']} className="sm:col-span-2">
            {({ id, describedBy, invalid }) => <TextArea id={id} value={f.policy} onChange={(e) => set('policy')(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid || undefined} className="font-mono text-sm" rows={4} placeholder="{}" />}
          </Field>
        </section>

        <div className="flex gap-2">
          <Button type="submit" variant="primary" size="lg" loading={busy}>
            Create exam
          </Button>
          <Button type="button" variant="ghost" size="lg" onClick={() => navigate('/examcell')}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
