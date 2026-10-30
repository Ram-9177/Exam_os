import { sha256Hex } from '../../lib/crypto.js';

/**
 * Safe Exam Browser configuration, built once as a settings object and emitted two ways from that same object:
 * the `.seb` XML property list the student opens, and the Config Key the server verifies on every gated request.
 *
 * Config Key (SEB specification): the settings dictionary without `originatorVersion`, serialised as JSON with the
 * keys of every dictionary ordered case-insensitively, no whitespace, slashes and non-ASCII left unescaped; the key
 * is the lower-case hex SHA-256 of that UTF-8 string. SEB then sends, per request,
 * `X-SafeExamBrowser-ConfigKeyHash = SHA-256(absolute URL + Config Key)`.
 *
 * Only booleans, integers, strings, arrays and dictionaries are emitted (no <real>, <data> or <date>), which keeps the
 * plist and the JSON form unambiguous. Acceptance with real SEB builds is part of the exam rehearsal: the readiness
 * check refuses a mismatching key, so a disagreement surfaces before the exam, never during it (docs/seb-rollout.md).
 */
export type SebValue = boolean | number | string | SebValue[] | { [key: string]: SebValue };
export type SebSettings = { [key: string]: SebValue };

export const SEB_OS = { MAC: 0, WINDOWS: 1 } as const;

export interface ProhibitedApp {
  description: string;
  /** Windows: the executable file name (Teams.exe). macOS: the process name. */
  executable: string;
  /** macOS bundle identifier; empty on Windows. */
  identifier?: string;
  os: 0 | 1;
}

const win = (description: string, executable: string): ProhibitedApp => ({ description, executable, os: SEB_OS.WINDOWS });
const mac = (description: string, executable: string, identifier: string): ProhibitedApp => ({ description, executable, identifier, os: SEB_OS.MAC });

/**
 * Applications SEB force-quits when it starts and keeps closed for the whole exam (`strongKill`: terminated without
 * asking the student). Communication, remote access, screen capture/streaming, AI assistants and hypervisors — on both
 * Windows and macOS. The Examination Section can add more per exam.
 */
export const DEFAULT_PROHIBITED_APPS: readonly ProhibitedApp[] = [
  // communication
  win('Microsoft Teams', 'ms-teams.exe'), win('Microsoft Teams (classic)', 'Teams.exe'), mac('Microsoft Teams', 'MSTeams', 'com.microsoft.teams2'), mac('Microsoft Teams (classic)', 'Microsoft Teams', 'com.microsoft.teams'),
  win('Zoom', 'Zoom.exe'), mac('Zoom', 'zoom.us', 'us.zoom.xos'),
  win('Skype', 'Skype.exe'), mac('Skype', 'Skype', 'com.skype.skype'),
  win('Slack', 'slack.exe'), mac('Slack', 'Slack', 'com.tinyspeck.slackmacgap'),
  win('Discord', 'Discord.exe'), mac('Discord', 'Discord', 'com.hnc.Discord'),
  win('Telegram', 'Telegram.exe'), mac('Telegram', 'Telegram', 'ru.keepcoder.Telegram'),
  win('WhatsApp', 'WhatsApp.exe'), mac('WhatsApp', 'WhatsApp', 'net.whatsapp.WhatsApp'),
  win('Signal', 'Signal.exe'), mac('Signal', 'Signal', 'org.whispersystems.signal-desktop'),
  win('Webex', 'CiscoCollabHost.exe'), mac('Webex', 'Webex', 'Cisco-Systems.Spark'),
  mac('Messages', 'Messages', 'com.apple.MobileSMS'), mac('FaceTime', 'FaceTime', 'com.apple.FaceTime'),
  // remote access
  win('TeamViewer', 'TeamViewer.exe'), mac('TeamViewer', 'TeamViewer', 'com.teamviewer.TeamViewer'),
  win('AnyDesk', 'AnyDesk.exe'), mac('AnyDesk', 'AnyDesk', 'com.philandro.anydesk'),
  win('RustDesk', 'rustdesk.exe'), mac('RustDesk', 'RustDesk', 'com.carriez.rustdesk'),
  win('Chrome Remote Desktop host', 'remoting_host.exe'),
  win('Remote Desktop Connection', 'mstsc.exe'), mac('Screen Sharing', 'Screen Sharing', 'com.apple.ScreenSharing'),
  win('VNC Viewer', 'vncviewer.exe'), win('VNC Server', 'winvnc.exe'), win('TightVNC Server', 'tvnserver.exe'),
  win('Parsec', 'parsecd.exe'), mac('Parsec', 'Parsec', 'tv.parsec.www'),
  win('Splashtop Streamer', 'SRServer.exe'),
  // screen capture and streaming
  win('OBS Studio', 'obs64.exe'), win('OBS Studio (32-bit)', 'obs32.exe'), mac('OBS Studio', 'OBS', 'com.obsproject.obs-studio'),
  win('Camtasia', 'CamtasiaStudio.exe'), win('Camtasia Recorder', 'CamRecorder.exe'),
  win('Snagit', 'Snagit32.exe'), win('Snagit Editor', 'SnagitEditor.exe'),
  win('ShareX', 'ShareX.exe'), win('Bandicam', 'bdcam.exe'), win('Greenshot', 'Greenshot.exe'), win('Lightshot', 'Lightshot.exe'),
  win('Snipping Tool', 'SnippingTool.exe'), win('Screen clipping', 'ScreenClippingHost.exe'), win('Xbox Game Bar', 'GameBar.exe'),
  win('Loom', 'Loom.exe'), mac('Loom', 'Loom', 'com.loom.desktop'),
  mac('QuickTime Player', 'QuickTime Player', 'com.apple.QuickTimePlayerX'), mac('Screenshot', 'Screenshot', 'com.apple.screenshot.launcher'),
  // AI assistants
  win('ChatGPT', 'ChatGPT.exe'), mac('ChatGPT', 'ChatGPT', 'com.openai.chat'),
  win('Claude', 'claude.exe'), mac('Claude', 'Claude', 'com.anthropic.claudefordesktop'),
  win('Microsoft Copilot', 'Copilot.exe'),
  // hypervisors (SEB also refuses to run inside a virtual machine)
  win('VirtualBox', 'VirtualBox.exe'), mac('VirtualBox', 'VirtualBox', 'org.virtualbox.app.VirtualBox'),
  win('VMware Workstation', 'vmware.exe'), win('VMware Player', 'vmplayer.exe'), mac('VMware Fusion', 'VMware Fusion', 'com.vmware.fusion'),
  mac('Parallels Desktop', 'Parallels Desktop', 'com.parallels.desktop.console'),
];

/** An Examination Section entry: `Something.exe` is a Windows executable, a dotted name is a macOS bundle identifier. */
export function prohibitedAppFromEntry(entry: string): ProhibitedApp {
  const e = entry.trim();
  if (/\.exe$/i.test(e)) return win(e, e);
  if (/^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/i.test(e)) return mac(e, e.split('.').pop()!, e);
  return win(e, e.endsWith('.exe') ? e : `${e}.exe`);
}

export interface SebBuildOptions {
  /** Origin the exam is served from, e.g. https://cs.exam.smru.edu.in — the only site the SEB browser may open. */
  origin: string;
  allowQuit?: boolean;
  quitPassword?: string;
  kioskMode?: boolean;
  blockVirtualMachines?: boolean;
  blockScreenCapture?: boolean;
  blockClipboard?: boolean;
  extraProhibited?: string[];
}

export function buildSebSettings(o: SebBuildOptions): SebSettings {
  const origin = o.origin.replace(/\/+$/, '');
  const host = new URL(origin).host;
  const kiosk = o.kioskMode ?? true;
  const apps = [...DEFAULT_PROHIBITED_APPS, ...(o.extraProhibited ?? []).map(prohibitedAppFromEntry)];
  const seen = new Set<string>();
  const prohibitedProcesses: SebValue[] = [];
  for (const a of apps) {
    const k = `${a.os}:${a.executable.toLowerCase()}:${(a.identifier ?? '').toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    prohibitedProcesses.push({ active: true, currentUser: true, description: a.description, executable: a.executable, identifier: a.identifier ?? '', os: a.os, strongKill: true });
  }
  const s: SebSettings = {
    originatorVersion: 'SMRU ExamOS SEB generator 2',
    startURL: `${origin}/student`,
    sendBrowserExamKey: true,
    // only the exam site; everything else is blocked by SEB
    URLFilterEnable: true,
    URLFilterEnableContentFilter: false,
    URLFilterRules: [
      { action: 1, active: true, expression: host, regex: false },
      { action: 1, active: true, expression: `${host}/*`, regex: false },
    ],
    browserViewMode: 1,
    browserWindowAllowReload: true,
    showReloadButton: true,
    allowPreferencesWindow: false,
    allowQuit: o.allowQuit ?? true,
    quitURL: `${origin}/student`,
    quitURLConfirm: true,
    // lock the machine to the exam
    createNewDesktop: kiosk,
    killExplorerShell: kiosk,
    enableAltTab: false,
    enableAltF4: false,
    enableCtrlEsc: false,
    enableStartMenu: false,
    enableRightMouse: false,
    enableF12: false,
    enableAppSwitcherCheck: true,
    forceAppFolderInstall: true,
    allowSiri: false,
    allowDictation: false,
    // one screen, no mirroring, no capture, no sharing, no VM
    allowedDisplaysMaxNumber: 1,
    allowedDisplayBuiltin: false,
    allowDisplayMirroring: false,
    enablePrintScreen: !(o.blockScreenCapture ?? true),
    allowScreenSharing: false,
    allowVirtualMachine: !(o.blockVirtualMachines ?? true),
    enablePrivateClipboard: o.blockClipboard ?? true,
    allowSpellCheck: false,
    // force-quit these at start and keep them closed
    prohibitedProcesses,
    allowedProcesses: [],
  };
  if (o.quitPassword) s['hashedQuitPassword'] = sha256Hex(o.quitPassword);
  return s;
}

const byKeyCaseInsensitive = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

function canonical(v: SebValue): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort(byKeyCaseInsensitive)) out[k] = canonical(v[k]!);
    return out;
  }
  return v;
}

/** The JSON SEB hashes: originatorVersion removed, keys ordered case-insensitively at every level, no whitespace. */
export function sebConfigKeyJson(settings: SebSettings): string {
  const { originatorVersion: _ignored, ...rest } = settings;
  void _ignored;
  return JSON.stringify(canonical(rest));
}

export function sebConfigKey(settings: SebSettings): string {
  return sha256Hex(sebConfigKeyJson(settings));
}

const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

function plistValue(v: SebValue, indent: string): string {
  const next = `${indent}  `;
  if (typeof v === 'boolean') return `${indent}<${v ? 'true' : 'false'}/>`;
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error('SEB settings use integers only');
    return `${indent}<integer>${v}</integer>`;
  }
  if (typeof v === 'string') return `${indent}<string>${xmlEscape(v)}</string>`;
  if (Array.isArray(v)) return v.length ? `${indent}<array>\n${v.map((x) => plistValue(x, next)).join('\n')}\n${indent}</array>` : `${indent}<array/>`;
  const keys = Object.keys(v).sort(byKeyCaseInsensitive);
  return `${indent}<dict>\n${keys.map((k) => `${next}<key>${xmlEscape(k)}</key>\n${plistValue(v[k]!, next)}`).join('\n')}\n${indent}</dict>`;
}

/** Plain (unencrypted, uncompressed) XML property list — a `.seb` file SEB opens directly. */
export function sebSettingsToPlist(settings: SebSettings): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${plistValue(settings, '')}\n</plist>\n`;
}
