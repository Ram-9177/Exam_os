import { afterEach, describe, expect, it } from 'vitest';
import { resetSebKeysForTest, sebHeaders } from '@/lib/seb';

type W = Window & { SafeExamBrowser?: unknown };
afterEach(() => {
  delete (window as W).SafeExamBrowser;
  resetSebKeysForTest();
  window.history.replaceState(null, '', '/');
});

describe('Safe Exam Browser JavaScript API headers', () => {
  it('sends nothing outside SEB — nothing is ever faked', () => {
    expect(sebHeaders()).toEqual({});
  });

  it('forwards the hashes SEB computed with the page URL they belong to, and asks SEB to recompute after SPA navigation', () => {
    let updates = 0;
    const sec = { configKey: 'c'.repeat(64), browserExamKey: 'b'.repeat(64), updateKeys: (cb: () => void) => { updates++; sec.configKey = 'd'.repeat(64); cb(); } };
    (window as W).SafeExamBrowser = { security: sec };
    window.history.replaceState(null, '', '/student');
    const first = sebHeaders();
    expect(first).toEqual({ 'x-seb-page-url': `${window.location.origin}/student`, 'x-seb-config-key-hash': 'c'.repeat(64), 'x-seb-bek-hash': 'b'.repeat(64) });
    window.history.pushState(null, '', '/student/attempts/a1/exam#q2');
    sebHeaders();
    expect(updates).toBe(1);
    expect(sebHeaders()).toMatchObject({ 'x-seb-page-url': `${window.location.origin}/student/attempts/a1/exam`, 'x-seb-config-key-hash': 'd'.repeat(64) });
  });
});
