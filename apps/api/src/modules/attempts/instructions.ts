/** Student-facing instruction text per check outcome; never reveals detection mechanics beyond the fix. */
export function instructionFor(code: string, status: string, remediation: string | null): string {
  if (status === 'PASS') return 'Ready';
  const map: Record<string, string> = {
    IDENTITY_SESSION: 'Sign in again with your university account.',
    ELIGIBILITY: 'You are not on the eligible list for this exam. Contact the Examination Section desk.',
    CLIENT_VERSION: 'Open the exam in the approved exam client (latest version). Support can install it for you.',
    NETWORK_SAVE_ROUNDTRIP: 'Your connection could not save a practice answer. Move closer to the access point or use the wired port, then retry.',
    CLOCK_SYNC: 'Your laptop clock is off. Enable automatic time in system settings and retry.',
    KEYBOARD_INPUT: 'Type the sample text in the practice box; speed does not matter. If a key fails, ask for a spare keyboard.',
    CANVAS_INPUT: 'Draw a circle, a box and an arrow in the practice canvas with your mouse, trackpad or stylus. Stylus is optional.',
    CAMERA: 'Allow camera access and keep your face in the frame. No camera? Ask for a loaner USB webcam.',
    MICROPHONE: 'Allow microphone access. Room noise is expected and is not a problem.',
    CONSENT: 'Read and accept the monitoring notice for this exam.',
    SYSTEM_SCAN: 'Use one screen only, close screen sharing, remote-desktop and automation tools, keep the exam window maximised, then run the system scan again.',
  };
  const base = map[code] ?? 'Ask the invigilator for help.';
  if (status === 'UNVERIFIABLE') return `${base} (This check cannot be verified on your device; the Examination Section may approve an exception.)`;
  if (remediation) return `${base} [${remediation}]`;
  return base;
}
