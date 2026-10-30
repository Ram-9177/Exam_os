import { describe, expect, it } from 'vitest';
import { waitFor, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MyExamsPage } from '@/features/student/MyExamsPage';
import { ExamDetailPage } from '@/features/examcell/ExamDetailPage';
import { mockFetch, renderApp, signInAs, TENANT } from './helpers';

const mockStudentExams = {
  exams: [
    {
      examId: 'e-seb-1',
      code: 'CS401-MID',
      title: 'Computer Networks & Security Mid-term',
      examType: 'MID_1',
      academicYear: '2026-27',
      semester: 7,
      examStatus: 'SCHEDULED',
      securityProfile: 'SECURE_BYOD',
      durationMinutes: 90,
      windowStartAt: new Date(Date.now() + 3600_000).toISOString(),
      windowEndAt: new Date(Date.now() + 7200_000).toISOString(),
      courseCode: 'CS401',
      courseName: 'Computer Networks',
      extraTimeMinutes: 0,
      attemptId: 'a-seb-1',
      attemptStatus: 'ALLOCATED',
      deadlineAt: null,
      hallTicketNumber: 'HT-401-001',
      hallTicketVerification: 'hash123',
    },
  ],
};

const mockExamDetail = {
  exam: {
    id: 'e-seb-1',
    code: 'CS401-MID',
    title: 'Computer Networks & Security Mid-term',
    status: 'SCHEDULED',
    exam_type: 'MID_1',
    academic_year: '2026-27',
    semester: 7,
    max_marks: 50,
    security_profile: 'SECURE_BYOD',
    duration_minutes: 90,
    window_start_at: new Date(Date.now() + 3600_000).toISOString(),
    window_end_at: new Date(Date.now() + 7200_000).toISOString(),
    warning_threshold: 5,
    policy: {
      sebConfigKey: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      sebGeneratedAt: '2026-10-30T10:00:00Z',
    },
    policy_version: 'v1',
    precheck_opened_at: null,
    started_at: null,
    closed_at: null,
    created_at: '2026-10-30T08:00:00Z',
  },
  attemptCounts: { ALLOCATED: 45 },
};

describe('Secure Client and Safe Exam Browser UI', () => {
  it('displays Safe Exam Browser badge and download link on student exams list', async () => {
    signInAs(['STUDENT']);
    const downloads: Array<{ path: string; auth: boolean }> = [];
    mockFetch((call) => {
      if (call.path.endsWith('/seb-config') && call.method === 'GET') {
        downloads.push({ path: call.path, auth: !!call.headers?.['authorization'] });
        return { status: 200, json: {} };
      }
      if (call.path === '/tenants/me') return { json: TENANT };
      if (call.path === '/auth/me') return { json: { userId: 'u1', email: 'student@demo.local', kind: 'STUDENT', grants: [{ role: 'STUDENT', scopeType: 'TENANT', scopeId: null }], tenant: TENANT } };
      if (call.path === '/student/me/exams') return { json: mockStudentExams };
      if (call.path === '/student/me/ledger') return { json: { records: [], semesters: [], overall: { exams: 0, semesters: 0, marks: 0, max_marks: 0, percentage: null } } };
      return undefined;
    });

    renderApp([{ path: '/student', element: <MyExamsPage /> }], '/student');

    expect(await screen.findByText('Computer Networks & Security Mid-term')).toBeInTheDocument();
    expect(screen.getByText('Safe Exam Browser')).toBeInTheDocument();

    // Downloaded through the API client with the access token — a plain link would carry no credentials and get a 401
    expect(screen.queryByRole('link', { name: 'Download .seb configuration' })).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Download .seb configuration' }));
    await waitFor(() => expect(downloads).toEqual([{ path: '/student/me/exams/e-seb-1/seb-config', auth: true }]));
    expect(screen.getByText(/closes chat, remote-access, recording and AI apps/)).toBeInTheDocument();
  });

  it('renders SEB Config Key and allows Exam Section to rebuild config', async () => {
    signInAs(['EXAM_CELL_OPERATOR']);

    let generated: Record<string, unknown> | null = null;
    mockFetch((call) => {
      if (call.path === '/tenants/me') return { json: TENANT };
      if (call.path === '/auth/me') return { json: { userId: 'u-ec', email: 'examcell@demo.local', kind: 'STAFF', grants: [{ role: 'EXAM_CELL_OPERATOR', scopeType: 'TENANT', scopeId: null }], tenant: TENANT } };
      if (call.path === '/exams/e-seb-1') return { json: mockExamDetail };
      if (call.method === 'POST' && call.path === '/exams/e-seb-1/seb-config') {
        generated = call.body as Record<string, unknown>;
        return {
          status: 201,
          json: {
            sebConfigKey: 'f9e8d7c6b5a4f9e8d7c6b5a4f9e8d7c6b5a4f9e8d7c6b5a4f9e8d7c6b5a4f9e8',
            generatedAt: new Date().toISOString(),
            downloadUrl: '/api/v1/exams/e-seb-1/seb-config',
          },
        };
      }
      return undefined;
    });

    const user = userEvent.setup();
    renderApp([{ path: '/examcell/exams/:id', element: <ExamDetailPage /> }], '/examcell/exams/e-seb-1');

    // Safe Exam Browser card rendered
    expect(await screen.findByRole('heading', { name: 'Safe Exam Browser' })).toBeInTheDocument();
    expect(screen.getByText('Required for this exam')).toBeInTheDocument();
    expect(screen.getByText(/closes Teams, Zoom, WhatsApp/)).toBeInTheDocument();

    // Key rendered
    const keyEl = screen.getByTestId('seb-config-key');
    expect(keyEl).toHaveTextContent(mockExamDetail.exam.policy.sebConfigKey);

    // Rebuild SEB config button
    await user.type(screen.getByLabelText(/Quit password/), 'invigilator-2026');
    await user.type(screen.getByLabelText(/Also force-close these apps/), 'LockDownHelper.exe{Enter}com.example.notes');
    await user.click(screen.getByRole('button', { name: /configuration$/ }));
    await waitFor(() => expect(generated).not.toBeNull());
    expect(generated).toMatchObject({ kioskMode: true, blockVirtualMachines: true, quitPassword: 'invigilator-2026', prohibitedProcesses: ['LockDownHelper.exe', 'com.example.notes'] });
  });
});

