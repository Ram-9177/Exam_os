import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnalyticsPage } from '@/features/analytics/AnalyticsPage';
import { mockFetch, renderApp, signInAs, TENANT } from './helpers';

const mockOverview = {
  departments: [
    {
      id: 'dept-cse',
      code: 'CSE',
      name: 'Computer Science and Engineering',
      studentCount: 120,
      publishedRecordsCount: 240,
      passRate: 91.5,
      avgPercentage: 78.4,
    },
    {
      id: 'dept-ece',
      code: 'ECE',
      name: 'Electronics and Communication Engineering',
      studentCount: 95,
      publishedRecordsCount: 180,
      passRate: 85.0,
      avgPercentage: 72.1,
    },
  ],
};

const mockDeptAnalytics = {
  department: {
    id: 'dept-cse',
    code: 'CSE',
    name: 'Computer Science and Engineering',
  },
  summary: {
    totalStudents: 120,
    totalExams: 6,
    totalPublishedResults: 240,
    avgPercentage: 78.4,
    passCount: 220,
    failCount: 20,
    passRate: 91.7,
  },
  semesterRollups: [
    {
      academicYear: '2026-27',
      semester: 5,
      examsCount: 3,
      studentCount: 120,
      avgPercentage: 79.2,
      passRate: 92.5,
    },
    {
      academicYear: '2026-27',
      semester: 3,
      examsCount: 3,
      studentCount: 115,
      avgPercentage: 77.6,
      passRate: 90.9,
    },
  ],
  examRollups: [
    {
      examId: 'e-os-mid1',
      examCode: 'CS301-MID1',
      examTitle: 'Operating Systems Mid-term 1',
      examType: 'MID_1',
      maxMarks: 50,
      avgMarks: 41.2,
      highestMarks: 49.0,
      lowestMarks: 18.0,
      candidateCount: 120,
      passCount: 112,
      passRate: 93.3,
    },
  ],
};

describe('Academic Analytics UI', () => {
  it('renders department summary KPIs, semester rollups, exam distribution, and privacy seal for HOD', async () => {
    // Sign in as HOD scoped to dept-cse
    const hod = signInAs(['HOD'], { id: 'u-hod', email: 'hod.cse@demo.local', fullName: 'Dr. Ramesh Kumar', kind: 'STAFF' });
    hod.grants = [{ role: 'HOD', scopeType: 'DEPARTMENT', scopeId: 'dept-cse' }];

    mockFetch((call) => {
      if (call.path === '/tenants/me') return { json: TENANT };
      if (call.path === '/auth/me') return { json: hod };
      if (call.path === '/analytics/overview') return { json: { overview: mockOverview } };
      if (call.path === '/analytics/department/dept-cse') return { json: { analytics: mockDeptAnalytics } };
      return undefined;
    });

    renderApp([{ path: '/analytics', element: <AnalyticsPage /> }], '/analytics');

    // Department header
    expect(await screen.findByRole('heading', { level: 2, name: /Computer Science and Engineering/i }, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText('Authorized Scope')).toBeInTheDocument();

    // Summary KPIs
    expect(screen.getAllByText('120').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.getByText('240')).toBeInTheDocument();
    expect(screen.getByText('78.4%')).toBeInTheDocument();
    expect(screen.getByText('91.7%')).toBeInTheDocument();

    // Semester rollups
    expect(screen.getByText('2026-27 · Semester 5')).toBeInTheDocument();
    expect(screen.getByText('92.5%')).toBeInTheDocument();

    // Exam-wise distribution
    expect(screen.getByText('Operating Systems Mid-term 1')).toBeInTheDocument();
    expect(screen.getByText('CS301-MID1 · MID_1')).toBeInTheDocument();
    expect(screen.getByText('93.3%')).toBeInTheDocument();

    // Privacy & integrity guarantee statement
    expect(screen.getByText('Privacy & Integrity Assurance')).toBeInTheDocument();
    expect(screen.getByText(/Proctoring observations, invigilation alerts, and device telemetry remain sealed/i)).toBeInTheDocument();
  });

  it('allows Controller to switch departments via the department selector', async () => {
    const controller = signInAs(['CONTROLLER'], { id: 'u-controller', email: 'controller@demo.local', fullName: 'Prof. R. Nair', kind: 'STAFF' });

    mockFetch((call) => {
      if (call.path === '/tenants/me') return { json: TENANT };
      if (call.path === '/auth/me') return { json: controller };
      if (call.path === '/analytics/overview') return { json: { overview: mockOverview } };
      if (call.path === '/analytics/department/dept-cse') return { json: { analytics: mockDeptAnalytics } };
      if (call.path === '/analytics/department/dept-ece') {
        return {
          json: {
            analytics: {
              ...mockDeptAnalytics,
              department: { id: 'dept-ece', code: 'ECE', name: 'Electronics and Communication Engineering' },
              summary: { ...mockDeptAnalytics.summary, totalStudents: 95 },
            },
          },
        };
      }
      return undefined;
    });

    const user = userEvent.setup();
    renderApp([{ path: '/analytics', element: <AnalyticsPage /> }], '/analytics');

    expect(await screen.findByRole('heading', { level: 2, name: /Computer Science and Engineering/i })).toBeInTheDocument();

    // Select ECE department
    const select = screen.getByLabelText('Select Department');
    await user.selectOptions(select, 'dept-ece');

    // Should load and display ECE
    expect(await screen.findByRole('heading', { level: 2, name: /Electronics and Communication Engineering/i })).toBeInTheDocument();
    expect(screen.getAllByText('95').length).toBeGreaterThanOrEqual(1);
  });
});
