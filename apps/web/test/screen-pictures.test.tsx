import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScreenPictures } from '@/features/proctor/ScreenPictures';
import { mockFetch, renderApp, signInAs, TENANT } from './helpers';

describe('proctor: the student’s screen', () => {
  it('shows the pictures newest first, which were not the entire screen, gaps and an overdue warning; opens one large', async () => {
    const me = signInAs(['CHIEF_PROCTOR']);
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:pic'), revokeObjectURL: vi.fn() }));
    const frames = [
      { id: 'f3', receivedAt: '2026-11-01T05:10:00.000Z', displaySurface: 'window', entireScreen: false, width: 1280, height: 720 },
      { id: 'f2', receivedAt: '2026-11-01T05:09:00.000Z', displaySurface: 'monitor', entireScreen: true, width: 1280, height: 720 },
    ];
    const { calls } = mockFetch(({ path }) => {
      if (path === '/auth/me') return { json: me };
      if (path === '/tenant') return { json: TENANT };
      if (path === '/proctor/attempts/att-1/screen-frames') return { json: { enabled: true, intervalSeconds: 30, lastFrameAt: frames[0]!.receivedAt, secondsSinceLastFrame: 240, overdue: true, gaps: [{ from: '2026-11-01T05:00:00.000Z', to: '2026-11-01T05:09:00.000Z', seconds: 540 }], frames } };
      if (path.startsWith('/proctor/screen-frames/')) return { json: {} };
      return undefined;
    });
    renderApp([{ path: '/', element: <ScreenPictures attemptId="att-1" tz="Asia/Kolkata" /> }], '/');
    expect(await screen.findByText('No picture for 4 min')).toBeInTheDocument();
    expect(screen.getByText(/1 gap: 10:30 am–10:39 am \(9 min\)/)).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Screen pictures' });
    expect(within(list).getAllByRole('button')).toHaveLength(2);
    expect(within(list).getByText(/not entire screen/)).toBeInTheDocument();
    await userEvent.click(within(list).getByRole('button', { name: /10:40/ }));
    expect(await screen.findByText(/window only/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/proctor/screen-frames/f3.jpg' && c.headers['authorization'] === 'Bearer access')).toBe(true);
  });
});
