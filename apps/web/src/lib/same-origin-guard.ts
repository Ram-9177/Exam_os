/**
 * The exam client talks to one server: its own origin. Third-party code loaded into the exam (the on-device face
 * detector's runtime, notably, which ships with usage telemetry to a Google endpoint) must not send anything from a
 * student's device during an exam. This refuses any fetch to another origin before a request is made.
 * Defence in depth: deployments should also send `Content-Security-Policy: connect-src 'self'`.
 */
let installed = false;
export const blockedRequests: string[] = [];

export function installSameOriginFetchGuard(win: Window & typeof globalThis = window): void {
  if (installed || typeof win.fetch !== 'function') return;
  installed = true;
  const original = win.fetch.bind(win);
  win.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let origin: string;
    try {
      origin = new URL(raw, win.location.href).origin;
    } catch {
      return original(input, init);
    }
    if (origin !== win.location.origin) {
      if (blockedRequests.length < 20) blockedRequests.push(origin);
      return Promise.reject(new TypeError(`ExamOS: request to ${origin} refused (exam client is same-origin only)`));
    }
    return original(input, init);
  }) as typeof fetch;
}

/** For tests. */
export function resetSameOriginGuardForTest(): void {
  installed = false;
  blockedRequests.length = 0;
}
