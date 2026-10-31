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
      // after the exam's mass release (e.g. a hold released later): one result may be published on its own
      if (method === 'GET' && path === `/exams/${EXAM}`) return { json: { exam: { id: EXAM, status: 'CLOSED', results_published_at: '2026-10-30T23:00:00.000Z' }, attemptCounts: {} } };
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

  it('results are released together: no single publication before the release, the button waits for every approval', async () => {
    const me = signInAs(['CONTROLLER'], { id: 'u-ctrl', email: 'admin@demo.local', fullName: 'Demo Admin', kind: 'STAFF' });
    let released: string | null = null;
    let pending = 1;
    const posts: unknown[] = [];
    const rows = () => [
      { ...row('CANDIDATE_APPROVED', null), attempt_id: 'a1', id: 'p1', fullName: 'Student 01' },
      { ...row(pending ? 'EXAM_CELL_REVIEW' : 'CANDIDATE_APPROVED', null), attempt_id: 'a2', id: 'p2', fullName: 'Student 02' },
      { ...row('INTEGRITY_HOLD', null), attempt_id: 'a3', id: 'p3', fullName: 'Student 03' },
    ];
    mockFetch(({ method, path, body }) => {
      if (method === 'GET' && path === '/auth/me') return { json: me };
      if (method === 'GET' && path === '/tenant') return { json: TENANT };
      if (method === 'GET' && path === `/exams/${EXAM}`) return { json: { exam: { id: EXAM, status: 'CLOSED', results_published_at: released }, attemptCounts: {} } };
      if (method === 'GET' && path === `/exams/${EXAM}/candidates`) return { json: { summary: { total: 3, ready: 0, approved: 2, published: 0, needsReview: 0, onHold: 1, awaitingMarks: 0 }, candidates: rows() } };
      if (method === 'GET' && path === `/candidates/a1/checklist`) return { json: { packet: { ...row('CANDIDATE_APPROVED', null), exam_id: EXAM, user_id: 'u1', sealed_submission_verified: true, checklist_digest: 'ab'.repeat(32) }, exam: { id: EXAM, code: 'CS301-MID1', title: 'OS', examType: 'MID_1' }, resultVersion: null, checks: [], publishable: true, liveApproval: { id: 'ap1', approverUserId: 'u-ec', resultVersionId: 'rv1', createdAt: '2026-10-30T23:02:07.000Z' } } };
      if (method === 'POST' && path === `/exams/${EXAM}/publish-results`) {
        posts.push(body);
        released = '2026-10-31T10:00:00.000Z';
        return { json: { publishedAt: released, published: 2, withheld: [{ attemptId: 'a3', status: 'INTEGRITY_HOLD' }], replayed: false } };
      }
      return undefined;
    });
    const view = renderApp([{ path: '/x', element: <CandidatesTab examId={EXAM} tz="Asia/Kolkata" active /> }], '/x');
    const user = userEvent.setup();
    const panel = await screen.findByRole('region', { name: 'Result release' });
    expect(within(panel).getByText(/1 not ready yet · 1 on hold/)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Release all results' })).toBeDisabled();
    // a single approved result cannot go out before everyone's
    await user.click(screen.getAllByRole('button', { name: 'Open' })[0]!);
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).queryByRole('button', { name: 'Authorize publication' })).not.toBeInTheDocument();
    expect(within(drawer).getByText(/Released with everyone else's results/)).toBeInTheDocument();
    view.unmount();

    pending = 0;
    renderApp([{ path: '/x', element: <CandidatesTab examId={EXAM} tz="Asia/Kolkata" active /> }], '/x');
    const panel2 = await screen.findByRole('region', { name: 'Result release' });
    await user.click(within(panel2).getByRole('button', { name: 'Release all results' }));
    const confirm = await screen.findByRole('dialog', { name: 'Release all results?' });
    expect(confirm).toHaveTextContent('2 students see their result at once; 1 on hold are withheld');
    await user.click(within(confirm).getByRole('button', { name: 'Release results' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(await screen.findByText(/Results released together on/)).toBeInTheDocument();
  });
});
