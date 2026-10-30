/**
 * Safe Exam Browser JavaScript API (SEB 3.x on macOS/iOS, and recent Windows builds). SEB computes
 * SHA-256(page URL + Config Key) and SHA-256(page URL + Browser Exam Key) for the page it shows; SEB for macOS/iOS
 * cannot add its headers to fetch(), so the page forwards these hashes with the URL they were computed for.
 * Outside SEB there is nothing to send and nothing is faked.
 */
interface SebSecurity {
  configKey?: string;
  browserExamKey?: string;
  updateKeys?: (callback: () => void) => void;
}
type SebWindow = Window & { SafeExamBrowser?: { security?: SebSecurity } };

let keysUrl: string | null = null;
let updating = false;

function security(): SebSecurity | null {
  if (typeof window === 'undefined') return null;
  return (window as SebWindow).SafeExamBrowser?.security ?? null;
}

export function inSafeExamBrowser(): boolean {
  return security() !== null || (typeof navigator !== 'undefined' && /SEB\//.test(navigator.userAgent));
}

/** Headers proving this page runs in SEB with the exam's configuration, or {} outside SEB. */
export function sebHeaders(): Record<string, string> {
  const sec = security();
  if (!sec?.configKey) return {};
  const here = window.location.href.split('#')[0]!;
  keysUrl ??= here;
  // A single-page app changes its URL without a reload: ask SEB to recompute for the new URL, and meanwhile send the
  // hashes together with the URL they belong to.
  if (keysUrl !== here && typeof sec.updateKeys === 'function' && !updating) {
    updating = true;
    sec.updateKeys(() => {
      keysUrl = window.location.href.split('#')[0]!;
      updating = false;
    });
  }
  const out: Record<string, string> = { 'x-seb-page-url': keysUrl, 'x-seb-config-key-hash': sec.configKey };
  if (sec.browserExamKey) out['x-seb-bek-hash'] = sec.browserExamKey;
  return out;
}

/** For tests. */
export function resetSebKeysForTest(): void {
  keysUrl = null;
  updating = false;
}
