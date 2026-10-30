import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProfilePage } from '@/features/student/ProfilePage';
import { mockFetch, renderApp, signInAs, TENANT } from './helpers';

const mockProfile = {
  student: {
    id: 'u-student-1',
    fullName: 'Ananya Sharma',
    email: 'ananya@demo.local',
    registerNumber: '2026-CSE-0042',
    admissionBatch: '2024',
    currentSemester: 5,
    section: 'A',
    preferredLanguage: 'English',
  },
  department: {
    id: 'dept-cse',
    code: 'CSE',
    name: 'Computer Science and Engineering',
  },
  programme: {
    id: 'prog-btech',
    code: 'BTECH-CSE',
    name: 'B.Tech in Computer Science',
  },
  documents: {
    photo: null,
  },
  hallTickets: [
    {
      examId: 'e-mid1',
      examCode: 'CS301-MID1',
      examTitle: 'Operating Systems Mid-term 1',
      examType: 'MID_1',
      hallTicketNumber: 'HT-2026-0042',
      hallTicketVerification: 'a1b2c3d4e5f6',
      windowStartAt: '2026-11-01T09:00:00Z',
      windowEndAt: '2026-11-01T11:00:00Z',
    },
  ],
  cumulative: {
    totalExams: 3,
    totalMarks: 245,
    totalMax: 300,
    percentage: 81.67,
    gpa: 8.5,
  },
};

const mockIdCard = {
  valid: true,
  tenantName: "St. Mary's University",
  fullName: 'Ananya Sharma',
  registerNumber: '2026-CSE-0042',
  departmentCode: 'CSE',
  departmentName: 'Computer Science and Engineering',
  programmeCode: 'BTECH-CSE',
  programmeName: 'B.Tech in Computer Science',
  currentSemester: 5,
  photoAvailable: false,
  issuedAt: '2026-10-30T10:00:00Z',
  qrDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
};

describe('Student Profile and ID Card UI', () => {
  it('renders student identity details, verifiable ID card, and cumulative analytics', async () => {
    signInAs(['STUDENT'], { id: 'u-student-1', email: 'ananya@demo.local', fullName: 'Ananya Sharma', kind: 'STUDENT' });

    mockFetch((call) => {
      if (call.path === '/tenants/me') return { json: TENANT };
      if (call.path === '/auth/me') return { json: { userId: 'u-student-1', email: 'ananya@demo.local', kind: 'STUDENT', grants: [{ role: 'STUDENT', scopeType: 'TENANT', scopeId: null }], tenant: TENANT } };
      if (call.path === '/student/profile') return { json: { profile: mockProfile } };
      if (call.path === '/student/profile/id-card') return { json: { idCard: mockIdCard } };
      return undefined;
    });

    renderApp([{ path: '/student/profile', element: <ProfilePage /> }], '/student/profile');

    // 1. Student identity details
    expect(await screen.findByRole('heading', { level: 2, name: 'Ananya Sharma' })).toBeInTheDocument();
    expect(screen.getAllByText('2026-CSE-0042').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Computer Science and Engineering (CSE)')).toBeInTheDocument();
    expect(screen.getByText('B.Tech in Computer Science (BTECH-CSE)')).toBeInTheDocument();
    expect(screen.getByText('Semester 5 · Sec A')).toBeInTheDocument();

    // Photo placeholder when not yet uploaded
    expect(screen.getByTestId('photo-placeholder')).toHaveTextContent('A');

    // 2. Verifiable ID card
    const idCardContainer = screen.getByTestId('id-card-container');
    expect(idCardContainer).toBeInTheDocument();
    expect(idCardContainer).toHaveTextContent('EXAMINATION IDENTITY CARD');
    expect(idCardContainer).toHaveTextContent('VALID');
    expect(idCardContainer).toHaveTextContent('REG: 2026-CSE-0042');
    expect(screen.getByAltText('Identity Verification QR Code')).toHaveAttribute('src', mockIdCard.qrDataUrl);

    // 3. Cumulative Analytics & SVG Progression Chart
    expect(screen.getAllByText('81.7%').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('8.50')).toBeInTheDocument();
    expect(screen.getByText('245 / 300')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Student exam marks progression chart' })).toBeInTheDocument();

    // 4. Hall tickets
    expect(screen.getByText('Operating Systems Mid-term 1')).toBeInTheDocument();
    expect(screen.getByText('HT-2026-0042')).toBeInTheDocument();
  });

  it('opens photo upload modal and enforces consent requirement', async () => {
    signInAs(['STUDENT']);
    const user = userEvent.setup();

    mockFetch((call) => {
      if (call.path === '/tenants/me') return { json: TENANT };
      if (call.path === '/auth/me') return { json: { userId: 'u1', email: 'test@demo.local', kind: 'STUDENT', grants: [{ role: 'STUDENT', scopeType: 'TENANT', scopeId: null }], tenant: TENANT } };
      if (call.path === '/student/profile') return { json: { profile: mockProfile } };
      if (call.path === '/student/profile/id-card') return { json: { idCard: mockIdCard } };
      return undefined;
    });

    renderApp([{ path: '/student/profile', element: <ProfilePage /> }], '/student/profile');

    const uploadBtn = await screen.findByRole('button', { name: 'Upload Photograph' });
    await user.click(uploadBtn);

    expect(screen.getByRole('dialog', { name: 'Upload Examination Photograph' })).toBeInTheDocument();
    expect(screen.getByText(/explicit consent for St. Mary's University/i)).toBeInTheDocument();

    // Button should be disabled until photo and consent are provided
    const submitBtn = screen.getByRole('button', { name: 'Confirm & Save Photo' });
    expect(submitBtn).toBeDisabled();
  });
});
