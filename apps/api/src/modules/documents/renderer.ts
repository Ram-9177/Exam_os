import { chromium, type Browser } from 'playwright';

let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    // CHROMIUM_EXECUTABLE_PATH pins a system/container Chromium when the bundled build is absent.
    const executablePath = process.env['CHROMIUM_EXECUTABLE_PATH'] || undefined;
    try {
      browserInstance = await chromium.launch({ headless: true, executablePath, args: executablePath ? ['--no-sandbox'] : [] });
    } catch {
      browserInstance = await chromium.launch({ channel: 'chrome', headless: true });
    }
  }
  return browserInstance;
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close().catch(() => undefined);
    browserInstance = null;
  }
}

export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    const buffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' },
    });
    return Buffer.from(buffer);
  } finally {
    await page.close();
  }
}

function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderCanvasToSvg(content: unknown): string {
  const c = content as { width?: number; height?: number; strokes?: Array<{ tool?: string; width?: number; points?: Array<[number, number]> }> };
  if (!c || !c.width || !c.height || !Array.isArray(c.strokes)) return '';
  const pens = c.strokes.filter((s) => s.tool === 'pen');
  const erasers = c.strokes.filter((s) => s.tool === 'eraser');
  const maskId = `mask-${Math.random().toString(36).slice(2, 9)}`;
  const pathOf = (s: { points?: Array<[number, number]> }) => {
    if (!s.points || s.points.length === 0) return '';
    const [x0, y0] = s.points[0]!;
    if (s.points.length === 1) return `M${x0} ${y0} L${x0 + 0.01} ${y0}`;
    return `M${x0} ${y0} ` + s.points.slice(1).map(([x, y]) => `L${x} ${y}`).join(' ');
  };
  return `
    <svg viewBox="0 0 ${c.width} ${c.height}" style="width: 100%; max-height: 400px; display: block; border: 1px solid #e5e7eb; background: #ffffff; border-radius: 4px; padding: 4px;">
      ${erasers.length > 0 ? `
        <defs>
          <mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="${c.width}" height="${c.height}">
            <rect x="0" y="0" width="${c.width}" height="${c.height}" fill="#fff" />
            ${erasers.map((s) => `<path d="${pathOf(s)}" stroke="#000" stroke-width="${s.width || 2}" fill="none" stroke-linecap="round" stroke-linejoin="round" />`).join('')}
          </mask>
        </defs>
      ` : ''}
      <g ${erasers.length > 0 ? `mask="url(#${maskId})"` : ''}>
        ${pens.map((s) => `<path d="${pathOf(s)}" stroke="#111827" stroke-width="${s.width || 2}" fill="none" stroke-linecap="round" stroke-linejoin="round" />`).join('')}
      </g>
    </svg>
  `;
}

export function renderBookletHtml(booklet: any, qrDataUrl: string): string {
  const b = booklet;
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(b.tenant?.name)} — Digital Answer Booklet</title>
  <style>
    @page { size: A4; margin: 12mm 10mm; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111827; background: #ffffff; margin: 0; font-size: 14px; line-height: 1.5; }
    .page-break { page-break-after: always; break-after: page; }
    .cover-box { border: 1px solid #d1d5db; border-radius: 6px; padding: 24px; margin-bottom: 24px; }
    .header-title { font-family: Georgia, serif; font-size: 26px; font-weight: bold; margin: 0; color: #111827; }
    .header-sub { font-size: 14px; color: #4b5563; margin-top: 4px; }
    .grid-table { width: 100%; border-collapse: collapse; margin-top: 16px; margin-bottom: 16px; }
    .grid-table th, .grid-table td { border: 1px solid #d1d5db; padding: 8px 12px; font-size: 13px; text-align: left; }
    .grid-table th { background: #f9fafb; font-weight: 600; color: #374151; width: 30%; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .qr-container { display: flex; align-items: center; justify-content: space-between; border: 1px solid #d1d5db; border-radius: 6px; padding: 16px; margin-top: 20px; background: #fdfdfd; }
    .qr-img { width: 110px; height: 110px; }
    .question-card { border: 1px solid #e5e7eb; border-radius: 6px; padding: 20px; margin-bottom: 20px; background: #ffffff; }
    .q-prompt { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 4px; padding: 12px; margin-bottom: 14px; white-space: pre-wrap; font-size: 14px; line-height: 1.6; }
    .ruled { background-image: linear-gradient(to bottom, transparent 27px, #e5e7eb 27px, #e5e7eb 28px); background-size: 100% 28px; line-height: 28px; min-height: 84px; white-space: pre-wrap; font-size: 15px; padding: 0 4px; margin-bottom: 12px; }
    .marks-badge { display: inline-block; padding: 4px 10px; border-radius: 4px; font-weight: bold; font-family: ui-monospace, monospace; border: 1px solid #111827; background: #f3f4f6; }
    .stamp { font-family: ui-monospace, monospace; text-transform: uppercase; font-weight: bold; font-size: 11px; padding: 2px 6px; border-radius: 3px; border: 1px solid #9ca3af; }
  </style>
</head>
<body>
  <!-- Cover Page -->
  <div class="cover-box">
    <div style="display: flex; justify-content: space-between; align-items: flex-start;">
      <div>
        <h1 class="header-title">${escapeHtml(b.tenant?.name)}</h1>
        <p class="header-sub">Official Digital Examination Answer Booklet</p>
      </div>
      <div style="text-align: right;">
        <span class="stamp">${escapeHtml(b.status || 'PUBLISHED')}</span>
      </div>
    </div>

    <table class="grid-table">
      <tr>
        <th>Candidate Name</th>
        <td><strong>${escapeHtml(b.student?.name)}</strong></td>
      </tr>
      <tr>
        <th>Register Number</th>
        <td class="mono">${escapeHtml(b.student?.registerNumber || '—')}</td>
      </tr>
      <tr>
        <th>Hall Ticket Number</th>
        <td class="mono">${escapeHtml(b.student?.hallTicket || '—')}</td>
      </tr>
      <tr>
        <th>Course &amp; Examination</th>
        <td>${escapeHtml(b.exam?.title)} (${escapeHtml(b.exam?.code)})</td>
      </tr>
      <tr>
        <th>Term &amp; Type</th>
        <td>${escapeHtml(b.exam?.academicYear || '—')} · Semester ${escapeHtml(b.exam?.semester || '—')} (${escapeHtml(b.exam?.examType)})</td>
      </tr>
      <tr>
        <th>Sealed Submission Manifest</th>
        <td class="mono" style="font-size: 11px; word-break: break-all;">${escapeHtml(b.manifestSha256 || '—')}</td>
      </tr>
      <tr>
        <th>Final Awarded Total</th>
        <td class="mono" style="font-size: 16px;"><strong>${escapeHtml(b.total ? `${b.total.marks} / ${b.total.max}` : 'Pending')}</strong> ${b.total?.version ? `(Version ${b.total.version})` : ''}</td>
      </tr>
      <tr>
        <th>Examiner Evaluation</th>
        <td>${escapeHtml(b.validation?.examiner || 'Pending')} ${b.validation?.examinerApprovedAt ? `on ${new Date(b.validation.examinerApprovedAt).toISOString()}` : ''}</td>
      </tr>
      <tr>
        <th>Controller Publication</th>
        <td>${escapeHtml(b.validation?.controller || 'Pending')} ${b.validation?.publishedAt ? `on ${new Date(b.validation.publishedAt).toISOString()}` : ''}</td>
      </tr>
    </table>

    <div class="qr-container">
      <div>
        <p style="margin: 0; font-weight: 600; font-size: 13px;">Online Ledger Verification</p>
        <p style="margin: 4px 0 0; font-size: 11px; color: #6b7280;">Scan this QR code to verify booklet validity and cryptographic hashes directly against the University Examination Ledger.</p>
        <p class="mono" style="margin: 6px 0 0; font-size: 10px; color: #4b5563; word-break: break-all;">Hash: ${escapeHtml(b.verificationHash || '—')}</p>
      </div>
      <img src="${qrDataUrl}" class="qr-img" alt="Verification QR Code" />
    </div>
  </div>

  <div class="page-break"></div>

  <!-- Questions and Answers -->
  <h2 style="font-size: 18px; border-bottom: 2px solid #111827; padding-bottom: 6px; margin-bottom: 16px;">Answer Scripts &amp; Evaluation</h2>
  ${(b.questions || []).map((q: any, i: number) => {
    const blocks = q.answer?.blocks || [];
    const textBlocks = blocks.filter((bl: any) => bl.kind === 'paragraph' && typeof bl.content === 'string' && bl.content.trim());
    const canvasBlocks = blocks.filter((bl: any) => bl.kind === 'canvas');
    return `
      <div class="question-card">
        <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px;">
          <h3 style="margin: 0; font-size: 16px;">Question ${i + 1} <span class="mono" style="font-size: 13px; color: #6b7280;">(${escapeHtml(q.questionId)})</span></h3>
          <div>
            <span class="marks-badge">${q.marks !== null ? q.marks : '—'} / ${q.maxMarks !== null ? q.maxMarks : '—'} marks</span>
          </div>
        </div>

        ${q.prompt ? `<div class="q-prompt"><strong style="font-size: 11px; text-transform: uppercase; color: #4b5563;">Prompt:</strong><br />${escapeHtml(q.prompt)}</div>` : ''}

        <div style="margin-top: 10px;">
          <strong style="font-size: 12px; color: #374151; text-transform: uppercase;">Candidate's Answer:</strong>
          ${textBlocks.length > 0 ? textBlocks.map((bl: any) => `<div class="ruled">${escapeHtml(bl.content)}</div>`).join('') : '<p style="color: #9ca3af; font-style: italic;">No text answer submitted.</p>'}
          ${canvasBlocks.map((bl: any) => renderCanvasToSvg(bl.content)).join('')}
        </div>

        ${q.explanation ? `
          <div style="background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 4px; padding: 10px; margin-top: 14px;">
            <p style="margin: 0; font-weight: 600; font-size: 12px; color: #334155;">Examiner Marks Explanation:</p>
            <p style="margin: 4px 0 0; font-size: 13px;">${escapeHtml(q.explanation)}</p>
          </div>
        ` : ''}

        <p class="mono" style="margin: 10px 0 0; font-size: 10px; color: #9ca3af;">
          Revision: ${escapeHtml(q.revision)} · Content Hash: ${escapeHtml(q.answerSha256 || 'none')}
        </p>
      </div>
    `;
  }).join('')}
</body>
</html>
  `;
}

export function renderHallTicketHtml(ticket: any, qrDataUrl: string): string {
  const t = ticket;
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Hall Ticket — ${escapeHtml(t.number)}</title>
  <style>
    @page { size: A4; margin: 15mm; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111827; background: #ffffff; margin: 0; font-size: 14px; line-height: 1.5; }
    .ticket-card { border: 2px solid #111827; border-radius: 8px; padding: 24px; }
    .header { text-align: center; border-bottom: 2px solid #111827; padding-bottom: 16px; margin-bottom: 20px; }
    .inst-name { font-family: Georgia, serif; font-size: 26px; font-weight: bold; margin: 0; }
    .ticket-title { font-size: 16px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin-top: 4px; color: #374151; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .ticket-number-badge { font-family: ui-monospace, monospace; font-size: 20px; font-weight: bold; border: 2px dashed #111827; padding: 6px 16px; display: inline-block; margin-top: 10px; background: #f9fafb; }
    .grid-table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    .grid-table th, .grid-table td { border: 1px solid #d1d5db; padding: 10px 14px; font-size: 14px; text-align: left; }
    .grid-table th { background: #f9fafb; font-weight: 600; width: 30%; color: #374151; }
    .qr-box { display: flex; align-items: center; justify-content: space-between; border: 1px solid #d1d5db; border-radius: 6px; padding: 16px; margin-top: 24px; background: #fdfdfd; }
    .qr-img { width: 120px; height: 120px; }
    .rules { margin-top: 24px; padding: 16px; border: 1px solid #e5e7eb; border-radius: 6px; background: #f9fafb; font-size: 12px; }
    .rules ul { margin: 6px 0 0; padding-left: 18px; }
    .rules li { margin-bottom: 4px; }
    .signature-area { margin-top: 40px; display: flex; justify-content: space-between; text-align: center; }
    .sig-line { border-top: 1px solid #111827; width: 200px; padding-top: 4px; font-size: 12px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="ticket-card">
    <div class="header">
      <h1 class="inst-name">${escapeHtml(t.tenantName || "St. Mary's University")}</h1>
      <div class="ticket-title">Examination Admission Hall Ticket</div>
      <div class="ticket-number-badge">${escapeHtml(t.number)}</div>
    </div>

    <table class="grid-table">
      <tr>
        <th>Candidate Name</th>
        <td><strong>${escapeHtml(t.studentName)}</strong></td>
      </tr>
      <tr>
        <th>Register / Roll Number</th>
        <td class="mono"><strong>${escapeHtml(t.registerNumber || '—')}</strong></td>
      </tr>
      <tr>
        <th>Course &amp; Exam</th>
        <td>${escapeHtml(t.examTitle)} (${escapeHtml(t.examCode)})</td>
      </tr>
      <tr>
        <th>Department &amp; Programme</th>
        <td>${escapeHtml(t.departmentName || t.departmentCode || '—')} · ${escapeHtml(t.programmeCode || '—')}</td>
      </tr>
      <tr>
        <th>Academic Term</th>
        <td>${escapeHtml(t.academicYear || '—')}${t.semester ? ` · Semester ${t.semester}` : ''}</td>
      </tr>
      <tr>
        <th>Exam Window</th>
        <td>${new Date(t.windowStartAt).toLocaleString()} to ${new Date(t.windowEndAt).toLocaleString()}</td>
      </tr>
      <tr>
        <th>Duration &amp; Security Profile</th>
        <td>${escapeHtml(t.durationMinutes)} minutes · ${escapeHtml(t.securityProfile)}</td>
      </tr>
    </table>

    <div class="qr-box">
      <div>
        <h4 style="margin: 0; font-size: 14px;">Instant Hall Ticket Authenticator</h4>
        <p style="margin: 4px 0 0; font-size: 12px; color: #4b5563;">Scan with any standard device at the examination hall gate to verify authentic seating allocation.</p>
        <p class="mono" style="margin: 6px 0 0; font-size: 11px; color: #6b7280;">Token Hash: ${escapeHtml(t.verificationHash)}</p>
      </div>
      <img src="${qrDataUrl}" class="qr-img" alt="Hall Ticket QR" />
    </div>

    <div class="rules">
      <strong>Important Candidate Guidelines:</strong>
      <ul>
        <li>Candidates must complete the mandatory 15-minute system readiness check before the exam window begins.</li>
        <li>Carry this authentic hall ticket along with an official university photo ID card.</li>
        <li>Opening another browser window, virtual machine, or device during SECURE_BYOD exams will trigger automatic proctor incident logging.</li>
      </ul>
    </div>

    <div class="signature-area">
      <div>
        <div class="sig-line">Candidate's Signature</div>
      </div>
      <div>
        <div class="sig-line">Controller of Examinations</div>
      </div>
    </div>
  </div>
</body>
</html>
  `;
}

export function renderEvidenceHtml(evidence: any, qrDataUrl: string): string {
  const e = evidence;
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Forensic Evidence Dossier — ${escapeHtml(e.attemptId)}</title>
  <style>
    @page { size: A4; margin: 12mm; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111827; background: #ffffff; margin: 0; font-size: 13px; line-height: 1.5; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .page-break { page-break-after: always; break-after: page; }
    .dossier-box { border: 2px solid #b91c1c; border-radius: 6px; padding: 20px; margin-bottom: 20px; background: #fff5f5; }
    .title { font-size: 20px; font-weight: bold; color: #991b1b; margin: 0; }
    .table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 12px; }
    .table th, .table td { border: 1px solid #d1d5db; padding: 6px 10px; text-align: left; }
    .table th { background: #f3f4f6; font-weight: 600; }
    .badge { display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: bold; }
    .badge-danger { background: #fee2e2; color: #991b1b; border: 1px solid #f87171; }
    .badge-ok { background: #dcfce7; color: #166534; border: 1px solid #86efac; }
  </style>
</head>
<body>
  <div class="dossier-box">
    <div style="display: flex; justify-content: space-between; align-items: flex-start;">
      <div>
        <h1 class="title">RESTRICTED FORENSIC INTEGRITY DOSSIER</h1>
        <p style="margin: 4px 0 0; color: #7f1d1d; font-size: 12px;">Authorized for Controller of Examinations &amp; Security Auditors Only</p>
      </div>
      <img src="${qrDataUrl}" style="width: 80px; height: 80px;" alt="QR" />
    </div>

    <table class="table" style="background: #ffffff; margin-top: 16px;">
      <tr><th>Attempt ID</th><td class="mono">${escapeHtml(e.attemptId)}</td></tr>
      <tr><th>Candidate</th><td>${escapeHtml(e.studentName)} (${escapeHtml(e.registerNumber || '—')})</td></tr>
      <tr><th>Exam</th><td>${escapeHtml(e.examTitle)} (${escapeHtml(e.examCode)})</td></tr>
      <tr><th>Integrity State</th><td><span class="badge ${e.integrityState === 'CLEAR' ? 'badge-ok' : 'badge-danger'}">${escapeHtml(e.integrityState)}</span></td></tr>
      <tr><th>Identity State</th><td><span class="badge ${e.identityState?.startsWith('VERIFIED') ? 'badge-ok' : 'badge-danger'}">${escapeHtml(e.identityState)}</span></td></tr>
      <tr><th>Manifest SHA-256</th><td class="mono" style="word-break: break-all;">${escapeHtml(e.manifestSha256 || '—')}</td></tr>
    </table>
  </div>

  <h2 style="font-size: 15px; margin-top: 24px; border-bottom: 1px solid #111827; padding-bottom: 4px;">Activity Timeline &amp; Tamper-Evident Hash Chain</h2>
  <table class="table">
    <thead>
      <tr>
        <th style="width: 50px;">Seq</th>
        <th style="width: 140px;">Timestamp</th>
        <th style="width: 120px;">Event</th>
        <th style="width: 80px;">Actor</th>
        <th>Hash</th>
      </tr>
    </thead>
    <tbody>
      ${(e.events || []).map((ev: any) => `
        <tr>
          <td class="mono">${ev.seq}</td>
          <td>${new Date(ev.server_received_at).toISOString()}</td>
          <td><strong>${escapeHtml(ev.event_type)}</strong></td>
          <td>${escapeHtml(ev.actor)}</td>
          <td class="mono" style="font-size: 10px; word-break: break-all;">${escapeHtml(ev.hash)}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>

  <h2 style="font-size: 15px; margin-top: 24px; border-bottom: 1px solid #111827; padding-bottom: 4px;">Proctor Incidents &amp; Warnings</h2>
  <table class="table">
    <thead>
      <tr>
        <th>Epoch</th>
        <th>Timestamp</th>
        <th>Signal Class</th>
        <th>Human Decision</th>
        <th>Reason &amp; Notes</th>
      </tr>
    </thead>
    <tbody>
      ${(e.warnings || []).length > 0 ? (e.warnings || []).map((w: any) => `
        <tr>
          <td class="mono">#${w.epoch_no || 1}</td>
          <td>${new Date(w.created_at).toISOString()}</td>
          <td><strong>${escapeHtml(w.signal_class || 'MANUAL')}</strong></td>
          <td><span class="badge badge-danger">${escapeHtml(w.decision_id ? 'CONFIRMED' : 'WARNING')}</span></td>
          <td>${escapeHtml(w.notes || '—')}</td>
        </tr>
      `).join('') : '<tr><td colspan="5" style="text-align: center; color: #9ca3af;">No countable proctor warnings recorded.</td></tr>'}
    </tbody>
  </table>
</body>
</html>
  `;
}

