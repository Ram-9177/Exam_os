import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScreenShareGate, useScreenWatch } from '@/features/exam/screen-watch';
import { SignalReporter, type SignalEvent } from '@/lib/signals';
import { setDeviceSession, setTokens } from '@/lib/api';
import { mockFetch } from './helpers';

function fakeStream(surface: string) {
  const track = { getSettings: () => ({ displaySurface: surface }), stop: vi.fn(), onended: null as null | (() => void) };
  return { stream: { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream, track };
}
function Harness({ reporter, active = true }: { reporter: SignalReporter; active?: boolean }) {
  const w = useScreenWatch({ enabled: true, active, attemptId: 'a1', intervalSeconds: 30, reporter, grab: async () => ({ image: 'data:image/jpeg;base64,/9j/AA==', width: 1280, height: 720 }) });
  return (
    <div>
      <p>status: {w.status}</p>
      {w.status === 'needs-share' ? <ScreenShareGate onShare={() => void w.start()} error={w.error} /> : null}
    </div>
  );
}

describe('screen watch in the exam workspace', () => {
  it('hides the paper until the entire screen is shared; a window is refused; pictures go to the server; stopping is flagged', async () => {
    setTokens({ accessToken: 'a', refreshToken: 'refresh-token-value-long-enough', expiresIn: 600, user: { id: 'u', email: 's@x', fullName: 'S', kind: 'STUDENT' } });
    setDeviceSession('dev-1');
    const { calls } = mockFetch(({ method, path }) => (method === 'POST' && path === '/student/attempts/a1/screen-frames' ? { status: 201, json: { frameId: 'f1' } } : undefined));
    const sent: SignalEvent[] = [];
    const reporter = new SignalReporter({ attemptId: 'a1', minIntervalMs: 0, send: async (ev) => void sent.push(...ev) });
    const window_ = fakeStream('window');
    const monitor = fakeStream('monitor');
    const getDisplayMedia = vi.fn().mockResolvedValueOnce(window_.stream).mockResolvedValueOnce(monitor.stream);
    Object.defineProperty(navigator, 'mediaDevices', { value: { getDisplayMedia }, configurable: true });
    render(<Harness reporter={reporter} />);
    const user = userEvent.setup();
    expect(screen.getByRole('alertdialog', { name: 'Share your entire screen' })).toBeInTheDocument();

    // a window instead of the whole screen: refused, flagged, asked again
    await user.click(screen.getByRole('button', { name: 'Share entire screen' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You shared a window');
    expect(window_.track.stop).toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({ signalClass: 'SCREEN_SHARE_ENDED', metadata: { reason: 'not-entire-screen', surface: 'window' } });
    expect(getDisplayMedia.mock.calls[0]![0]).toMatchObject({ video: { displaySurface: 'monitor' }, audio: false });

    // the entire screen: the gate goes and a picture is sent at once, from this device
    await user.click(screen.getByRole('button', { name: 'Share entire screen' }));
    expect(await screen.findByText('status: sharing')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(calls.filter((c) => c.path === '/student/attempts/a1/screen-frames')).toHaveLength(1));
    const upload = calls.find((c) => c.path === '/student/attempts/a1/screen-frames')!;
    expect(upload.body).toEqual({ image: 'data:image/jpeg;base64,/9j/AA==', width: 1280, height: 720, displaySurface: 'monitor' });
    expect(upload.headers['x-device-session']).toBe('dev-1');

    // the student stops sharing from the browser bar: flagged, and the paper is hidden again
    act(() => monitor.track.onended?.());
    expect(await screen.findByRole('alertdialog', { name: 'Share your entire screen' })).toBeInTheDocument();
    expect(sent.at(-1)).toMatchObject({ signalClass: 'SCREEN_SHARE_ENDED', metadata: { reason: 'stopped' } });
  });

  it('refusing the share is flagged; a device that cannot share is on record but never blocked', async () => {
    const sent: SignalEvent[] = [];
    const reporter = new SignalReporter({ attemptId: 'a1', minIntervalMs: 0, send: async (ev) => void sent.push(...ev) });
    Object.defineProperty(navigator, 'mediaDevices', { value: { getDisplayMedia: vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) }, configurable: true });
    const view = render(<Harness reporter={reporter} />);
    await userEvent.click(screen.getByRole('button', { name: 'Share entire screen' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Screen sharing was not allowed');
    expect(sent.at(-1)).toMatchObject({ signalClass: 'SCREEN_SHARE_ENDED', metadata: { reason: 'refused', error: 'NotAllowedError' } });
    view.unmount();

    Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true });
    sent.length = 0;
    render(<Harness reporter={reporter} />);
    expect(await screen.findByText('status: unsupported')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(sent).toEqual([expect.objectContaining({ signalClass: 'SCREEN_SHARE_ENDED', metadata: { reason: 'unsupported' } })]);
  });
});
