import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { setTokens, setDeviceSession } from '@/lib/api';

// jsdom has no SubtleCrypto; the app hashes with WebCrypto, so bring Node's implementation in.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
if (typeof window !== 'undefined') {
  // jsdom lacks these; components call them defensively but tests should not throw.
  window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
  // jsdom's getContext only logs "not implemented"; the drawing surface tolerates a null context.
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', { value: () => null, configurable: true });
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  setTokens(null);
  setDeviceSession(null);
  vi.unstubAllGlobals();
});
