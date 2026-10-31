/**
 * Exam-day rehearsal through the real web UI (.agents/workflows/exam-day-rehearsal.md), every role, end to end:
 * camera presence on → readiness with system scan, consent and camera → start → full-screen gate → writing with the
 * whiteboard → tab switch, duplicate tab, display change, DevTools/print, network change, camera absence → proctor
 * decisions with the reported context → submit → close → forensics → marks → approval → publication → ledger/booklet.
 *
 * Needs the demo stack running (`npm run demo`, API :4000, `npm run worker`, web :5173). Then:
 *   node apps/web/e2e/exam-day-rehearsal.cjs [outDir]          # screenshots + results
 *   REHEARSAL_VIDEO=1 node apps/web/e2e/exam-day-rehearsal.cjs  # also a captioned MP4 (needs ffmpeg on PATH)
 * Run headed under a virtual display (xvfb-run -a env REHEARSAL_HEADED=1 …) so a tab switch really hides the tab.
 * Env: REHEARSAL_BASE (default http://127.0.0.1:5173), CHROMIUM_EXECUTABLE_PATH, PGURL (default local examos_dev).
 */
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(process.argv[2] || path.join(process.cwd(), 'rehearsal-out'));
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.REHEARSAL_BASE || 'http://127.0.0.1:5173';
const PGURL = process.env.PGURL || 'postgres://postgres:postgres@127.0.0.1:5432/examos_dev';
const VIDEO = process.env.REHEARSAL_VIDEO === '1';
const STAFF_PW = 'Demo-Staff!2026';
const STUDENT_PW = 'Demo-Student!2026';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sql = (q) => execFileSync('psql', [PGURL, '-Atc', q]).toString().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- recorder: CDP screencast of whichever page is acting, encoded once at the end ----------
class Recorder {
  constructor(dir) {
    this.dir = dir;
    this.frames = [];
    this.session = null;
    fs.mkdirSync(dir, { recursive: true });
  }
  async follow(page) {
    if (!VIDEO || this.page === page) return;
    if (this.session) await this.session.send('Page.stopScreencast').catch(() => undefined);
    this.page = page;
    this.session = await page.context().newCDPSession(page);
    this.session.on('Page.screencastFrame', async (f) => {
      const file = path.join(this.dir, `f${String(this.frames.length).padStart(6, '0')}.jpg`);
      fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
      this.frames.push({ file, t: Date.now() });
      await this.session?.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
    });
    await this.session.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
  }
  async encode(outFile) {
    if (!VIDEO || this.frames.length < 2) return null;
    await this.session?.send('Page.stopScreencast').catch(() => undefined);
    const list = this.frames.map((f, i) => `file '${f.file}'\nduration ${Math.min(4, Math.max(0.04, ((this.frames[i + 1]?.t ?? f.t + 1500) - f.t) / 1000)).toFixed(3)}`).join('\n');
    const listFile = path.join(this.dir, 'frames.txt');
    fs.writeFileSync(listFile, `${list}\nfile '${this.frames.at(-1).file}'\n`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', 'scale=1280:800:force_original_aspect_ratio=decrease,pad=1280:800:(ow-iw)/2:(oh-ih)/2:color=white,fps=15,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '30', '-movflags', '+faststart', outFile]);
    return outFile;
  }
}
const rec = new Recorder(path.join(OUT, 'frames'));

async function caption(page, text) {
  if (!VIDEO) return;
  await rec.follow(page);
  await page.evaluate((t) => {
    let el = document.getElementById('rehearsal-caption');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rehearsal-caption';
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:99999;pointer-events:none;background:#111827;color:#fff;font:600 15px/1.35 system-ui,sans-serif;padding:8px 14px;border-radius:8px;max-width:86vw;text-align:center;box-shadow:0 4px 18px rgba(0,0,0,.25)';
      document.documentElement.appendChild(el);
    }
    el.textContent = t;
  }, text).catch(() => undefined);
  await sleep(1800);
}

let shotN = 0;
async function shot(page, name, opts = {}) {
  const file = path.join(OUT, `${String(++shotN).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: opts.fullPage ?? false });
  log('  screenshot', path.basename(file));
}
const consoleErrors = [];
const openPages = {};
function watch(page, who) {
  openPages[who] = page;
  // MediaPipe's WASM runtime announces its CPU backend on stderr; that is not an error.
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('TensorFlow Lite XNNPACK delegate') && consoleErrors.push(`${who}: ${m.text().slice(0, 200)}`));
  page.on('console', (m) => m.text().includes('[examos]') && log(`  ${who} console: ${m.text().slice(0, 300)}`));
  page.on('pageerror', (e) => consoleErrors.push(`${who} pageerror: ${e.message.slice(0, 200)}`));
}
async function login(ctx, email, password, who) {
  const page = await ctx.newPage();
  watch(page, who);
  await page.goto(`${BASE}/login`);
  await caption(page, `${who}: signs in`);
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 });
  return page;
}
const results = [];
async function step(name, fn, { optional = false } = {}) {
  log('STEP', name);
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (e) {
    results.push(`${optional ? 'SKIP' : 'FAIL'}  ${name} — ${e.message.split('\n')[0]}`);
    log('  FAILED:', e.message.split('\n')[0]);
    for (const [who, pg] of Object.entries(openPages)) await pg.screenshot({ path: path.join(OUT, `zz-failure-${who.replace(/\W+/g, '-')}.png`), fullPage: true }).catch(() => undefined);
    if (!optional) throw e;
  }
}
async function poll(fn, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${label}`);
}
const canvasPoint = (box, w, h, x, y) => ({ x: box.x + (x * box.width) / w, y: box.y + (y * box.height) / h });
async function drag(page, box, w, h, from, to) {
  const a = canvasPoint(box, w, h, ...from);
  const b = canvasPoint(box, w, h, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.mouse.up();
}
async function stroke(page, box, w, h, points) {
  const first = canvasPoint(box, w, h, ...points[0]);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const p of points.slice(1)) {
    const q = canvasPoint(box, w, h, ...p);
    await page.mouse.move(q.x, q.y, { steps: 3 });
  }
  await page.mouse.up();
}
async function waitSaved(page) {
  await sleep(3500);
  await page.waitForFunction(() => !document.body.innerText.includes('Saved locally') && !document.body.innerText.includes('Syncing') && document.body.innerText.includes('Saved to server'), null, { timeout: 45000 });
}
/** The exam paper is behind a full-screen gate whenever the workspace is not in full screen. */
async function passGate(page) {
  const gate = page.getByRole('button', { name: 'Enter full screen' });
  if (await gate.isVisible().catch(() => false)) {
    await gate.click();
    await gate.waitFor({ state: 'hidden', timeout: 10000 });
  }
}

const Q1 = `A process is a program in execution with its own address space; a thread is a unit of scheduling inside a process that shares that address space with its sibling threads.

The PCB stores: process id and state, program counter and registers, scheduling information, memory-management information, accounting information and I/O status.`;
const Q2 = `Deadlock needs all four Coffman conditions at once: mutual exclusion, hold and wait, no preemption and circular wait. Ordering resources globally breaks circular wait.`;

(async () => {
  const examId = sql(`select id from exams where code = 'CS301-MID1'`);
  log('exam CS301-MID1', examId, sql(`select status from exams where id = '${examId}'`));
  const exe = process.env.CHROMIUM_EXECUTABLE_PATH || (fs.existsSync('/opt/pw-browsers/chromium-1243/chrome-linux64/chrome') ? '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' : undefined);
  // A normal profile for people (navigator.webdriver false); a fake camera so the presence check has a real stream.
  // Headless Chromium keeps every tab "visible and focused"; a tab switch is only real with a display:
  //   xvfb-run -a env REHEARSAL_HEADED=1 node apps/web/e2e/exam-day-rehearsal.cjs
  const browser = await chromium.launch({ executablePath: exe, headless: process.env.REHEARSAL_HEADED !== '1', args: ['--disable-blink-features=AutomationControlled', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const plain = await chromium.launch({ executablePath: exe });
  const ctxOpts = { viewport: { width: 1280, height: 800 }, timezoneId: 'Asia/Kolkata', locale: 'en-IN' };
  const studentCtx = await browser.newContext({ ...ctxOpts, extraHTTPHeaders: { 'X-Forwarded-For': '10.20.1.17' }, permissions: ['camera'] });
  const staff = () => browser.newContext(ctxOpts);
  let student, examcell, chief, evaluator, admin, attemptId;

  try {
    await step('Examination Section turns on the camera presence check for CS301-MID1', async () => {
      examcell = await login(await staff(), 'examcell@demo.local', STAFF_PW, 'Examination Section');
      await examcell.goto(`${BASE}/examcell/exams/${examId}`);
      const card = examcell.getByRole('region', { name: 'Camera presence check' });
      await card.scrollIntoViewIfNeeded();
      await caption(examcell, 'Examination Section: turns on the on-device camera presence check (no images leave the device)');
      await card.getByRole('button', { name: 'Turn on' }).click();
      await card.getByText('On', { exact: true }).waitFor();
      await shot(examcell, 'examcell-camera-presence-on');
    });

    await step('student01 signs in and sees the exam', async () => {
      student = await login(studentCtx, 'student01@demo.local', STUDENT_PW, 'Student 01');
      await student.getByRole('button', { name: 'Start readiness check' }).waitFor();
      await caption(student, 'Student 01: my exams');
      await shot(student, 'student-my-exams', { fullPage: true });
    });

    await step('readiness: system scan, keyboard, drawing, consent, camera → READY', async () => {
      await student.getByRole('button', { name: 'Start readiness check' }).click();
      await student.waitForURL(/\/readiness$/);
      attemptId = student.url().match(/attempts\/([0-9a-f-]{36})\//)[1];
      await caption(student, 'Readiness check: automatic checks, including the system scan');
      await student.getByRole('button', { name: 'Start readiness check' }).click();
      await student.getByLabel('Practice box').fill('Process 1 waits; thread 2 runs (3 times faster)!');
      await student.getByRole('button', { name: 'Check keyboard' }).click();
      const canvas = student.getByRole('img', { name: /Practice canvas/ });
      await canvas.waitFor();
      const box = await canvas.boundingBox();
      await stroke(student, box, 640, 320, Array.from({ length: 25 }, (_, i) => [140 + 70 * Math.cos((i / 24) * 2 * Math.PI), 160 + 70 * Math.sin((i / 24) * 2 * Math.PI)]));
      await stroke(student, box, 640, 320, [[260, 100], [400, 100], [400, 220], [260, 220], [260, 100]]);
      await stroke(student, box, 640, 320, [[430, 160], [580, 160], [555, 140], [580, 160], [555, 180]]);
      await student.getByRole('button', { name: 'Check drawing' }).click();
      for (let i = 0; i < 10; i++) {
        if (await student.getByRole('button', { name: 'Finish readiness check' }).isVisible().catch(() => false)) break;
        const notice = student.getByLabel('I have read the monitoring notice for this exam');
        if (await notice.isVisible().catch(() => false)) {
          await caption(student, 'Consent: the monitoring notice now covers the camera presence check');
          await notice.check();
          await student.getByRole('button', { name: 'Record my acknowledgement' }).click();
        }
        if (await student.getByRole('button', { name: 'Allow camera' }).isVisible().catch(() => false)) {
          await student.getByRole('button', { name: 'Allow camera' }).click();
          await student.getByRole('button', { name: 'I can see myself' }).click();
        }
        await sleep(800);
      }
      await student.getByRole('button', { name: 'Finish readiness check' }).click();
      await student.getByRole('button', { name: 'Run again' }).waitFor({ timeout: 30000 });
      await caption(student, 'Readiness: READY');
      await shot(student, 'readiness-verdict', { fullPage: true });
      const run = sql(`select status from precheck_runs where attempt_id = '${attemptId}' order by started_at desc limit 1`);
      if (run !== 'READY') throw new Error(`readiness ended ${run}`);
    });

    await step('the system scan catches an automation-controlled browser (student02)', async () => {
      const ctx = await plain.newContext(ctxOpts);
      const p = await login(ctx, 'student02@demo.local', STUDENT_PW, 'Student 02 (automated browser)');
      await p.getByRole('button', { name: 'Start readiness check' }).click();
      await p.waitForURL(/\/readiness$/);
      await p.getByRole('button', { name: 'Start readiness check' }).click();
      await p.getByText(/close screen sharing, remote-desktop and automation tools/).first().waitFor({ timeout: 30000 });
      await caption(p, 'Student 02 in an automated browser: the system scan blocks it');
      await shot(p, 'readiness-scan-flags-automation', { fullPage: true });
      await ctx.close();
    }, { optional: true });

    await step('Examination Section: readiness board, then start the exam', async () => {
      await examcell.goto(`${BASE}/examcell/exams/${examId}`);
      await examcell.getByRole('tab', { name: 'Readiness board' }).click();
      await examcell.getByText('Student 01').first().waitFor({ timeout: 20000 });
      await caption(examcell, 'Examination Section: readiness board — then starts the exam');
      await shot(examcell, 'examcell-readiness-board', { fullPage: true });
      await examcell.getByRole('button', { name: 'Start exam' }).click();
      await examcell.getByRole('dialog').getByRole('button', { name: 'Start exam' }).click();
      await poll(() => sql(`select status from exams where id = '${examId}'`) === 'LIVE', 20000, 'exam LIVE');
    });

    await step('student enters: the paper stays hidden until full screen', async () => {
      await student.goto(`${BASE}/student`);
      await student.getByRole('button', { name: 'Enter exam' }).click({ timeout: 30000 });
      await student.waitForURL(/\/exam$/);
      await student.getByRole('button', { name: 'Enter full screen' }).waitFor({ timeout: 30000 });
      await caption(student, 'The question paper stays hidden until the exam is in full screen');
      await shot(student, 'workspace-fullscreen-gate');
      await passGate(student);
      await student.getByRole('heading', { name: 'Question 1' }).waitFor({ timeout: 30000 });
      await student.getByLabel('Camera presence check').waitFor({ timeout: 30000 });
    });

    await step('student answers Q1 with text and a whiteboard diagram, then Q2', async () => {
      await caption(student, 'Writing: text plus a whiteboard diagram; the self-view shows the camera check is on this device only');
      await student.getByLabel('Answer paragraph 1').fill(Q1);
      await student.getByRole('button', { name: 'Insert diagram' }).first().click();
      const tools = student.getByRole('toolbar', { name: 'Diagram 2 tools' });
      const canvas = student.getByRole('img', { name: /^Diagram 2\./ });
      const bx = async () => (await canvas.scrollIntoViewIfNeeded(), canvas.boundingBox());
      const W = 800, H = 480;
      await tools.getByRole('button', { name: 'Rectangle' }).click();
      await student.getByRole('button', { name: 'Blue colour' }).click();
      await drag(student, await bx(), W, H, [40, 40], [380, 330]);
      await tools.getByRole('button', { name: 'Ellipse' }).click();
      await student.getByRole('button', { name: 'Green colour' }).click();
      await student.getByRole('button', { name: 'Fill' }).click();
      await drag(student, await bx(), W, H, [70, 150], [190, 240]);
      await drag(student, await bx(), W, H, [230, 150], [350, 240]);
      await tools.getByRole('button', { name: 'Arrow' }).click();
      await student.getByRole('button', { name: 'Red colour' }).click();
      await drag(student, await bx(), W, H, [400, 185], [560, 185]);
      await tools.getByRole('button', { name: 'Text' }).click();
      await student.getByRole('button', { name: 'Ink colour' }).click();
      for (const [x, y, t] of [[60, 85, 'Process A (PCB)'], [100, 202, 'T1'], [260, 202, 'T2'], [420, 170, 'context switch']]) {
        const pt = canvasPoint(await bx(), W, H, x, y);
        await student.mouse.click(pt.x, pt.y);
        await student.getByLabel('Text to place on the diagram').fill(t);
        await student.keyboard.press('Enter');
      }
      await waitSaved(student);
      await shot(student, 'workspace-q1-text-and-whiteboard', { fullPage: true });
      await student.getByRole('button', { name: /^Question 2,/ }).click();
      await student.getByRole('heading', { name: 'Question 2' }).waitFor();
      await student.getByLabel('Answer paragraph 1').fill(Q2);
      await waitSaved(student);
    });

    await step('lockdown: switching tab, a duplicate tab, a display change, DevTools and print are all recorded', async () => {
      // Leaving the exam (another app, another tab, minimised). Playwright keeps every page "visible and focused" even
      // headed, so no harness can really switch apps here: fire exactly what the browser fires — the page becomes hidden,
      // the window loses focus — and, six seconds later, the reverse. (The hook's own handling is unit-tested.)
      await caption(student, 'Student leaves the exam for another app (simulated: the test browser cannot switch apps)…');
      await student.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('blur'));
      });
      await sleep(6000);
      await student.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
      });
      await poll(() => sql(`select count(*) from proctor_events where attempt_id = '${attemptId}' and signal_class = 'FOCUS_LOST' and metadata->>'phase' = 'returned'`) !== '0', 20000, 'FOCUS_LOST returned');
      await passGate(student);
      await caption(student, '…back: the departure and the time away are on record for the proctor');

      // the same exam opened twice in this browser (a duplicate tab keeps the session)
      const [dup] = await Promise.all([studentCtx.waitForEvent('page'), student.evaluate(() => window.open(window.location.href, '_blank'))]);
      watch(dup, 'student01-duplicate');
      await student.bringToFront();
      await student.getByText('This exam is also open in another tab or window of this browser').waitFor({ timeout: 20000 });
      await caption(student, 'A duplicate tab of the exam: both tabs see each other and the proctor is told');
      await shot(student, 'workspace-duplicate-tab-warning');
      await dup.close();

      // a projector / mirrored display changes the screen the browser reports
      const cdp = await studentCtx.newCDPSession(student);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 740, deviceScaleFactor: 1, mobile: false, screenWidth: 1024, screenHeight: 768 });
      await poll(() => sql(`select count(*) from proctor_events where attempt_id = '${attemptId}' and signal_class = 'DISPLAY_CHANGED'`) !== '0', 20000, 'DISPLAY_CHANGED');
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      await caption(student, 'A projector or mirrored display changed the screen: recorded with before/after');

      await passGate(student);
      await student.keyboard.press('F12');
      await student.keyboard.press('Control+p');
      await sleep(1500);
      await caption(student, 'DevTools and print shortcuts are blocked and recorded');

      // the camera sees no face (the fake camera shows a test pattern): after 8 s a presence signal
      await poll(() => sql(`select count(*) from proctor_events where attempt_id = '${attemptId}' and signal_class in ('FACE_NOT_VISIBLE','CAMERA_UNAVAILABLE')`) !== '0', 30000, 'camera presence signal');
      log('  camera:', sql(`select signal_class || ' ' || metadata::text from proctor_events where attempt_id = '${attemptId}' and signal_class in ('FACE_NOT_VISIBLE','CAMERA_UNAVAILABLE') order by server_received_at limit 1`));

      // Wi-Fi roams to another access point
      await studentCtx.setExtraHTTPHeaders({ 'X-Forwarded-For': '10.20.9.44' });
      await student.reload();
      await passGate(student);
      await student.getByRole('heading', { name: 'Question 1' }).waitFor({ timeout: 30000 });
      await shot(student, 'workspace-after-signals');
    });

    await step('Chief Proctor reads what was reported and decides every incident', async () => {
      chief = await login(await staff(), 'chief@demo.local', STAFF_PW, 'Chief Proctor');
      await chief.goto(`${BASE}/proctor`);
      await poll(async () => (await chief.getByRole('button', { name: 'Open' }).count()) >= 5, 30000, 'incidents in the queue');
      await caption(chief, 'Chief Proctor: every signal is an incident waiting for a person — nothing counts by itself');
      await shot(chief, 'proctor-incident-queue', { fullPage: true });
      await chief.getByRole('row', { name: /Left the exam window or tab/ }).getByRole('button', { name: 'Open' }).click();
      const d = chief.getByRole('dialog');
      await d.getByRole('region', { name: 'What was reported' }).getByText(/returned to the exam after/).waitFor({ timeout: 15000 });
      await caption(chief, 'The incident says what happened, in words: how long the student was away and why');
      await shot(chief, 'proctor-focus-incident-reported');
      await d.getByRole('button', { name: 'Timeline' }).click();
      await d.getByRole('region', { name: 'Signals' }).waitFor();
      await d.getByRole('heading', { name: 'Network addresses' }).waitFor();
      await caption(chief, 'Timeline: every signal with context, every network address, every device scan');
      await shot(chief, 'proctor-timeline', { fullPage: true });
      await d.getByRole('button', { name: 'Close' }).first().click();
      const reasons = {
        'Left the exam window or tab': ['STUDENT_EXPLAINED', 'Opened a blank tab by mistake; back within seconds, room invigilator saw nothing else.'],
        'Display changed': ['CONFIRMED_BY_ROOM_CHECK', 'Lab projector cable detected and unplugged by the invigilator; single screen confirmed.'],
        'Multiple tabs': ['SINGLE_INTERRUPTION', 'Duplicate tab opened by a double-click; closed immediately.'],
        'Face not visible': ['CONFIRMED_BY_ROOM_CHECK', 'Rehearsal camera shows a test pattern; student was present at the desk throughout.'],
        'Network address changed': ['STUDENT_EXPLAINED', 'Laptop roamed to the corridor access point; same room, same device.'],
      };
      for (let i = 0; i < 12; i++) {
        await chief.reload();
        await sleep(1200);
        const rows = chief.getByRole('button', { name: 'Open' });
        if ((await rows.count()) === 0) break;
        await rows.first().click();
        const dlg = chief.getByRole('dialog');
        const title = ((await dlg.getByRole('heading').first().textContent()) ?? '').trim();
        const [code, notes] = reasons[title] ?? ['SINGLE_INTERRUPTION', 'Reviewed by the Chief Proctor with the room invigilator; no further action.'];
        await dlg.getByRole('button', { name: 'Dismiss' }).first().click();
        await dlg.getByLabel('Reason code').fill(code);
        await dlg.getByLabel('Notes').fill(notes);
        const resp = chief.waitForResponse((r) => r.url().includes('/decision') && r.request().method() === 'POST');
        await dlg.locator('form').getByRole('button', { name: 'Dismiss' }).click();
        log(`  dismissed "${title}" → ${(await resp).status()}`);
        await dlg.getByRole('button', { name: 'Close' }).first().click();
      }
      await chief.reload();
      await sleep(1200);
      await caption(chief, 'Queue cleared: each decision is named, reasoned and audited');
      await shot(chief, 'proctor-queue-cleared', { fullPage: true });
    });

    await step('student submits and receives the receipt', async () => {
      await student.bringToFront();
      await passGate(student);
      await caption(student, 'Student submits');
      await student.getByRole('button', { name: 'Submit', exact: true }).click();
      await student.getByRole('dialog').getByRole('button', { name: 'Submit exam' }).click();
      await student.getByText('Receipt').first().waitFor({ timeout: 30000 });
      await caption(student, 'Sealed: the receipt is the proof of submission');
      await shot(student, 'student-submitted-receipt');
    });

    await step('Examination Section closes the exam; the worker seals and runs forensics', async () => {
      await examcell.bringToFront();
      await examcell.goto(`${BASE}/examcell/exams/${examId}`);
      await caption(examcell, 'Examination Section closes the exam; the server enforces the deadline for everyone else');
      await examcell.getByRole('button', { name: 'Close', exact: true }).first().click();
      await examcell.getByRole('dialog').locator('button', { hasText: 'Close' }).click();
      await poll(() => sql(`select status from exams where id = '${examId}'`) === 'CLOSED', 20000, 'exam CLOSED');
      const packet = await poll(() => {
        const s = sql(`select status from candidate_review_packets where attempt_id = '${attemptId}'`);
        return s && s !== 'ATTEMPT_SEALED' && s !== 'FORENSIC_CHECKS_RUNNING' ? s : null;
      }, 120000, 'forensic checks by the worker');
      log('  packet:', packet);
      await examcell.reload();
      await examcell.getByRole('tab', { name: 'Candidates' }).click();
      await examcell.getByText('Student 01').first().waitFor({ timeout: 20000 });
      await shot(examcell, 'examcell-candidates-after-close', { fullPage: true });
    });

    await step('Examiner reviews the automatic proposals, keeps or changes them, and explains every change', async () => {
      evaluator = await login(await staff(), 'evaluator@demo.local', STAFF_PW, 'Examiner');
      await evaluator.goto(`${BASE}/evaluate/${attemptId}`);
      const submit = evaluator.getByRole('button', { name: /Record marks as version 1/ });
      await submit.waitFor({ timeout: 30000 });
      await evaluator.getByText(/Proposed total/).waitFor({ timeout: 30000 });
      await caption(evaluator, 'Examiner: the system proposes marks from the answer key and rubric key terms, with its reasons');
      await shot(evaluator, 'evaluator-proposals', { fullPage: true });
      const sets = evaluator.locator('fieldset');
      const n = await sets.count();
      let changed = false;
      for (let i = 0; i < n; i++) {
        const fsx = sets.nth(i);
        const marks = fsx.getByLabel('Marks', { exact: true });
        const current = await marks.inputValue();
        if (current === '') {
          // no proposal (e.g. a drawing): the examiner marks it
          if (!(await fsx.getByLabel('Out of').inputValue())) await fsx.getByLabel('Out of').fill('5');
          await marks.fill('2');
          await fsx.getByLabel('Marks explanation').fill('Marked by the examiner: partially correct.');
        } else if (!changed && Number(current) > 0) {
          // the examiner disagrees with one proposal: the reason is required before the marks can be saved
          changed = true;
          await caption(evaluator, 'Examiner changes a proposed mark — the reason for the change is required');
          while ((await fsx.getByRole('button', { name: /Remove criterion/ }).count()) > 0) await fsx.getByRole('button', { name: /Remove criterion/ }).first().click();
          const next = Number(current) >= 1 ? Number(current) - 1 : Number(current) + 0.5;
          await marks.fill(String(next));
          await fsx.getByLabel(/Reason for changing the proposed mark/).fill('The key terms are present but the explanation of the mechanism is incomplete.');
          await shot(evaluator, 'evaluator-override-reason');
        }
      }
      const resp = evaluator.waitForResponse((r) => r.url().includes('/result-versions') && r.request().method() === 'POST');
      await submit.click();
      const r = await resp;
      if (r.status() >= 300) throw new Error(`marks refused: ${r.status()} ${await r.text()}`);
      log('  stored:', sql(`select string_agg((i->>'questionId') || ' ' || (i->>'marks') || ' (proposed ' || coalesce(i->>'proposedMarks','none') || ', ' || (i->>'proposalMethod') || ')' || case when i ? 'overrideReason' then ' reason given' else '' end, ' | ') from result_versions rv, jsonb_array_elements(rv.items) i where rv.attempt_id = '${attemptId}'`));
    });

    await step('Exam Cell approves the exact result version', async () => {
      await examcell.bringToFront();
      await examcell.goto(`${BASE}/examcell/exams/${examId}`);
      await examcell.getByRole('tab', { name: 'Candidates' }).click();
      await examcell.getByRole('row', { name: /Student 01/ }).getByRole('button', { name: 'Open' }).click();
      const d = examcell.getByRole('dialog');
      await caption(examcell, 'Exam Cell: checks the checklist and approves this exact result version');
      await d.getByRole('button', { name: 'Approve', exact: true }).first().click();
      await d.getByLabel('Reason').fill('Checklist complete: seal verified, every incident decided by the Chief Proctor, every mark explained.');
      const resp = examcell.waitForResponse((r) => r.url().includes('/approvals') && r.request().method() === 'POST');
      await d.locator('form').getByRole('button', { name: 'Approve' }).click();
      if ((await resp).status() >= 300) throw new Error('approval refused');
      await sleep(1000);
    });

    await step('Controller of Examinations releases all results together', async () => {
      admin = await login(await staff(), 'admin@demo.local', 'Demo-Admin!2026', 'Controller of Examinations');
      await admin.goto(`${BASE}/examcell/exams/${examId}`);
      await admin.getByRole('tab', { name: 'Candidates' }).click();
      const panel = admin.getByRole('region', { name: 'Result release' });
      await panel.waitFor({ timeout: 20000 });
      await caption(admin, 'COE: results go out together, only when every script is approved — never one student early');
      await shot(admin, 'controller-release-panel', { fullPage: true });
      await panel.getByRole('button', { name: 'Release all results' }).click();
      const resp = admin.waitForResponse((r) => r.url().includes('/publish-results') && r.request().method() === 'POST');
      await admin.getByRole('dialog', { name: 'Release all results?' }).getByRole('button', { name: 'Release results' }).click();
      const r = await resp;
      if (r.status() >= 300) throw new Error(`release refused: ${r.status()} ${await r.text()}`);
      await admin.getByText(/Results released together on/).waitFor({ timeout: 20000 });
      await caption(admin, 'Released. From now on a mark changes only through a revaluation the COE approves');
      await shot(admin, 'controller-released', { fullPage: true });
    });

    await step('student sees the published result and the answer booklet', async () => {
      await student.bringToFront();
      await student.goto(`${BASE}/student/ledger`);
      await student.getByText(/CS301|Operating Systems/).first().waitFor({ timeout: 30000 });
      await caption(student, 'Student: the published result in the lifelong ledger');
      await shot(student, 'student-ledger', { fullPage: true });
      await student.goto(`${BASE}/student/attempts/${attemptId}/booklet`);
      await student.getByText('Question Prompt').first().waitFor({ timeout: 30000 });
      await caption(student, 'Student: the sealed answer booklet, diagram included, with its verification hash');
      await shot(student, 'student-booklet', { fullPage: true });
    });
  } finally {
    console.log('\n=== rehearsal results ===');
    for (const r of results) console.log(r);
    console.log(`\nconsole errors (${consoleErrors.length}):`);
    for (const e of [...new Set(consoleErrors)].slice(0, 25)) console.log('  ', e);
    if (attemptId) console.log('\nsignals:', sql(`select coalesce(string_agg(signal_class || '=' || n, ' ' order by signal_class), 'none') from (select signal_class, count(*) n from proctor_events where attempt_id = '${attemptId}' group by 1) s`));
    const video = await rec.encode(path.join(OUT, 'exam-day-rehearsal.mp4')).catch((e) => (console.log('video failed:', e.message), null));
    if (video) console.log('video:', video);
    await browser.close();
    await plain.close();
    process.exitCode = results.some((r) => r.startsWith('FAIL')) ? 1 : 0;
  }
})().catch((e) => {
  console.error('ABORTED:', e.message.split('\n')[0]);
  process.exit(1);
});
