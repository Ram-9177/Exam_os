import { afterEach, describe, expect, it, vi } from 'vitest';
import { blockedRequests, installSameOriginFetchGuard, resetSameOriginGuardForTest } from '@/lib/same-origin-guard';

describe('same-origin fetch guard (loaded with the on-device face detector)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetSameOriginGuardForTest();
  });

  it('refuses third-party requests before they leave the device and lets the exam API through', async () => {
    const inner = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = inner as unknown as typeof fetch;
    installSameOriginFetchGuard(window as Window & typeof globalThis);
    await expect(fetch('https://odml.pa.googleapis.com/v1/log', { method: 'POST' })).rejects.toThrow(/refused/);
    expect(inner).not.toHaveBeenCalled();
    expect(blockedRequests).toEqual(['https://odml.pa.googleapis.com']);
    await fetch('/api/v1/proctor/events', { method: 'POST' });
    await fetch(`${window.location.origin}/models/blaze_face_short_range.tflite`);
    expect(inner).toHaveBeenCalledTimes(2);
  });
});
