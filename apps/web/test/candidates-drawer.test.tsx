import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CandidatesTab } from '@/features/examcell/CandidatesTab';
import type { CandidateRow } from '@/features/examcell/api';
import { mockFetch, renderApp, signInAs, TENANT } from './helpers';

const EXAM = 'e1';
const ATTEMPT = 'a1';
const row = (status: CandidateRow['status'], publishedAt: string | null): CandidateRow => ({
  id: 'p1', attempt_id: ATTEMPT, status, version: 7, result_version_id: 'rv1', academic_state: 'MARKED', identity_state: 'VERIFIED_SESSION', integrity_state: 'CLEAR', media_quality_state: 'NOT_APPLICABLE', hold_reason: null,
  fullName: 'Student 01', registerNumber: '22CSE001', hallTicket: 'CS301-MID1-0001', resultVersion: 1, totalMarks: '8.50', maxMarks: '20.00', published_at: publishedAt,
});

/**
 * Found by running the exam end to end: after the Controller published, the
 * open drawer kept the row it was opened with — "Candidate approved" and the
 * "Authorize publication" button — while the table behind it said Published.
 */
describe('Candidate drawer', () => {
  it('follows the live candidate after an action: a published candidate no longer offers publication', async () => {
    const me = signInAs(['CONTROLLER'], { id: 'u-ctrl', email: 'admin@demo.local', fullName: 'Demo Admin', kind: 'STAFF' });
    let published = false;
    const posts: string[] = [];
    mockFetch(({ method, path }) => {
      if (method === 'GET' && path === '/auth/me') return { json: me };
      if (method === 'GET' && path === '/tenant') return { json: TENANT };
      if (method === 'GET' && path === `/exams/${EXAM}/candidates`) {
        const c = row(published ? 'PUBLISHED' : 'CANDIDATE_APPROVED', published ? '2026-10-30T23:02:10.000Z' : null);
        return { json: { summary: { total: 1, ready: 0, approved: published ? 0 : 1, published: published ? 1 : 0, needsReview: 0, onHold: 0, awaitingMarks: 0 }, candidates: [c] } };
      }
      if (method === 'GET' && path === `/candidates/${ATTEMPT}/checklist`) {
        return {
          json: {
            packet: { ...row(published ? 'PUBLISHED' : 'CANDIDATE_APPROVED', null), exam_id: EXAM, user_id: 'u1', sealed_submission_verified: true, checklist_digest: 'ab'.repeat(32) },
            exam: { id: EXAM, code: 'CS301-MID1', title: 'Operating Systems — Mid 1', examType: 'MID_1' },
            resultVersion: { id: 'rv1', version: 1, total_marks: '8.50', max_marks: '20.00', approved_by: 'u-ev', approved_at: '2026-10-30T23:02:06.000Z' },
            checks: [{ code: 'SEALED_SUBMISSION', ok: true, detail: 'manifest verified' }],
            publishable: !published,
            liveApproval: { id: 'ap1', approverUserId: 'u-ec', resultVersionId: 'rv1', createdAt: '2026-10-30T23:02:07.000Z' },
          },
        };
      }
      if (method === 'POST' && path === `/candidates/${ATTEMPT}/authorize-publication`) {
        posts.push(path);
        published = true;
        return { status: 201, json: { status: 'PUBLISHED' } };
      }
      return undefined;
    });
    renderApp([{ path: '/x', element: <CandidatesTab examId={EXAM} tz="Asia/Kolkata" active /> }], '/x');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Open' }));
    const drawer = await screen.findByRole('dialog');
    await user.click(within(drawer).getByRole('button', { name: 'Authorize publication' }));
    await user.click(within(drawer).getByRole('button', { name: 'Publish result' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    await waitFor(() => expect(within(drawer).queryByRole('button', { name: 'Authorize publication' })).not.toBeInTheDocument());
    expect(within(drawer).getAllByText('Published').length).toBeGreaterThan(0);
  });
});
