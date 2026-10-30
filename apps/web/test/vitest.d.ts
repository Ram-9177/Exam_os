/* eslint-disable @typescript-eslint/no-empty-object-type */
import 'vitest';
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

// jest-dom ships its augmentation against the root workspace's vitest; this app resolves a nested vitest,
// so the matcher types are declared here against the module instance the tests actually import.
declare module 'vitest' {
  interface Assertion<T = unknown> extends TestingLibraryMatchers<T, void> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<unknown, void> {}
}
