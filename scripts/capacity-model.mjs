#!/usr/bin/env node
/**
 * SMRU ExamOS — capacity & budget model (peak-only sizing).
 *
 * The exam workload is peaky: N students sit together for D hours a few times a
 * term, while each student only accumulates ~20 exam-hours a year. This script
 * turns the request mix the platform actually generates (see apps/web/src/lib/sync.ts
 * and apps/web/src/features/exam/session.ts) into request rates, database growth,
 * bandwidth and an Azure list-price estimate, so the numbers in
 * docs/capacity-and-budget.md can be regenerated with different assumptions.
 *
 * Usage:
 *   node scripts/capacity-model.mjs                       # defaults: 1,000 students, 3.5 h
 *   node scripts/capacity-model.mjs --students=3000 --hours=3 --media=1
 *   node scripts/capacity-model.mjs --json
 *
 * Every price is a list-price estimate (Azure Central India, Oct 2026) and is
 * labelled as such; replace them with your negotiated rates. Nothing here is a
 * measurement — the Gate G load test is what turns these into measured numbers.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const num = (k, d) => (args[k] === undefined ? d : Number(args[k]));

const input = {
  // Sitting shape
  students: num('students', 1000), // concurrent candidates in one sitting
  hours: num('hours', 3.5), // writing time per sitting
  precheckMinutes: num('precheck', 15), // readiness window before start (policy allows up to 120)
  // Client behaviour (from the shipped web client)
  saveMaxWaitSec: num('saveMaxWait', 15), // AnswerSync maxWaitMs — upper bound on saves while typing
  typingFraction: num('typing', 0.7), // share of the sitting a student spends changing an answer
  heartbeatSec: num('heartbeat', 20), // HEARTBEAT_MS
  proctorEventsPerMin: num('events', 0.5), // average signals per student per minute (focus loss, fullscreen, etc.)
  precheckItems: num('precheckItems', 10), // readiness items verified per student
  paperKB: num('paperKB', 300), // question paper + assets per student at admission
  // Row sizes (bytes incl. index overhead)
  revisionBytes: num('revisionBytes', 700), // answer_revisions row: ops delta + hashes + indexes
  eventBytes: num('eventBytes', 500), // attempt_event_log / proctor_events row
  finalDocKB: num('finalDocKB', 20), // answer_documents final content per student
  walBytesPerWrite: num('walBytes', 1500),
  // Year shape
  totalStudents: num('totalStudents', 10000), // enrolled students across the tenant(s)
  examHoursPerStudentYear: num('hoursPerStudent', 20), // "per student it may have 20 hrs"
  // Media tier for Gate C (not built): 0 = signals only (today), 1 = snapshots, 2 = continuous video
  mediaTier: num('media', 0),
  snapshotKB: num('snapshotKB', 50),
  snapshotIntervalSec: num('snapshotInterval', 60),
  videoKbps: num('videoKbps', 500),
  // Azure Central India list prices (USD) — ESTIMATES, verify in the pricing calculator
  price: {
    apiBurstNodeHour: num('pApiNode', 0.111), // Standard_D4as_v5 (4 vCPU / 16 GB), Linux PAYG
    apiBaseNodeHour: num('pApiBase', 0.06), // Standard_D2as_v5-class node, always on
    pgBaseHour: num('pPgBase', 0.1), // Flexible Server Burstable B2ms-class, always on
    pgBurstHour: num('pPgBurst', 0.5), // Flexible Server General Purpose D4ds_v5 (~$366/mo)
    pgStorageGBMonth: num('pPgStorage', 0.115), // Flexible Server premium SSD
    pgBackupGBMonth: num('pPgBackup', 0.08),
    blobHotGBMonth: num('pBlobHot', 0.02),
    blobArchiveGBMonth: num('pBlobArchive', 0.002),
    egressGB: num('pEgress', 0.1),
    redisMonth: num('pRedis', 16), // Azure Cache for Redis Basic C0 (or 0 if self-hosted on the API node)
    monitoringMonth: num('pMonitoring', 20),
    loadBalancerMonth: num('pLb', 20),
    powerAutomatePremiumUserMonth: num('pPaPremium', 15), // flow owner needs Premium (HTTP trigger is a premium connector)
    acsEmail: num('pAcsEmail', 0.00025), // Azure Communication Services Email, per message (bulk lane fallback)
    burstDayHours: num('burstDayHours', 24), // how long burst capacity stays up per exam day
  },
  tenants: num('tenants', 1),
  usdToInr: num('inr', 85),
};

const S = input.students;
const sittingSec = input.hours * 3600;

// --- Request rates (steady state during writing) -----------------------------
const savesPerSec = (S * input.typingFraction) / input.saveMaxWaitSec; // realistic
const savesPerSecWorst = S / input.saveMaxWaitSec; // everyone typing continuously
const heartbeatsPerSec = S / input.heartbeatSec;
const eventsPerSec = (S * input.proctorEventsPerMin) / 60;
const steadyReqPerSec = savesPerSec + heartbeatsPerSec + eventsPerSec;
const steadyReqPerSecWorst = savesPerSecWorst + heartbeatsPerSec + eventsPerSec;

// Bursts
const precheckReqPerSec = (S * input.precheckItems) / (input.precheckMinutes * 60) + S / (input.precheckMinutes * 60); // items + logins
const admitBurstPerSec = S / 120; // everyone enters within ~2 min of the Exam Section starting the exam
const submitBurstPerSec = S / 300; // everyone submits within the last ~5 min

// --- Database ----------------------------------------------------------------
// saveAnswer: insert answer_revisions + update answer_documents (2 writes); heartbeat: 1 update; event: ~1.5 writes (event + incident grouping)
const rowWritesPerSec = savesPerSecWorst * 2 + heartbeatsPerSec * 1 + eventsPerSec * 1.5;
const walBytesPerSec = rowWritesPerSec * input.walBytesPerWrite;
const walGBPerSitting = (walBytesPerSec * sittingSec) / 1e9;

const revisionsPerStudent = (sittingSec / input.saveMaxWaitSec) * input.typingFraction;
const eventsPerStudent = (sittingSec / 60) * input.proctorEventsPerMin + 60; // + lifecycle/attempt log entries
const dbGrowthBytesPerSitting =
  S * (revisionsPerStudent * input.revisionBytes + eventsPerStudent * input.eventBytes + input.finalDocKB * 1024 + 50 * 1024);
const dbGrowthGBPerSitting = dbGrowthBytesPerSitting / 1e9;

// --- Bandwidth -----------------------------------------------------------------
const perStudentKbps = ((2048 / input.saveMaxWaitSec) * 8) / 1000 + ((1024 / input.heartbeatSec) * 8) / 1000; // ~2 KB save round trip + ~1 KB heartbeat round trip incl. headers/TLS
const aggregateMbps = (perStudentKbps * S) / 1000;
const admissionBurstMbps = ((S * input.paperKB * 1024 * 8) / 120) / 1e6; // everyone fetching the paper within ~2 min
const paperGB = (S * input.paperKB * 1024) / 1e9;
const egressGBPerSitting = paperGB + (S * 2 * 1024 * 1024) / 1e9 + ((savesPerSec * 400 * sittingSec) / 1e9); // paper + SPA assets (~2 MB, cached) + save receipts

// Media (Gate C) -----------------------------------------------------------------
let mediaGBPerSitting = 0;
let mediaIngestMbps = 0;
if (input.mediaTier === 1) {
  mediaGBPerSitting = (S * (sittingSec / input.snapshotIntervalSec) * input.snapshotKB * 1024) / 1e9;
  mediaIngestMbps = ((input.snapshotKB * 8) / input.snapshotIntervalSec / 1000) * S; // Mbps aggregate
} else if (input.mediaTier === 2) {
  mediaGBPerSitting = (S * sittingSec * input.videoKbps * 1000) / 8 / 1e9;
  mediaIngestMbps = (S * input.videoKbps) / 1000;
}

// --- Sizing recommendation -----------------------------------------------------
// Rule of thumb: budget ~250 req/s of transactional traffic per 4 vCPU Node API node (keeps p95 < 300 ms headroom), ×1.5 safety, minimum 2 for HA.
const apiNodes = Math.max(2, Math.ceil((steadyReqPerSecWorst * 1.5) / 250));
const pgTier = rowWritesPerSec < 400 ? 'General Purpose D4ds_v5 (4 vCPU)' : rowWritesPerSec < 1200 ? 'General Purpose D8ds_v5 (8 vCPU)' : 'General Purpose D16ds_v5 (16 vCPU)';
const pgBurstHour = rowWritesPerSec < 400 ? input.price.pgBurstHour : rowWritesPerSec < 1200 ? input.price.pgBurstHour * 2 : input.price.pgBurstHour * 4;
const mediaNodes = input.mediaTier === 2 ? Math.ceil(mediaIngestMbps / 200) : input.mediaTier === 1 ? 1 : 0;

// --- Cost per sitting (one exam day) ------------------------------------------
const p = input.price;
const burstHours = p.burstDayHours;
const costApiBurst = apiNodes * burstHours * p.apiBurstNodeHour;
const costPgBurst = burstHours * (pgBurstHour - p.pgBaseHour);
const costMediaNodes = mediaNodes * burstHours * p.apiBurstNodeHour;
const costEgress = egressGBPerSitting * p.egressGB;
const costWal = walGBPerSitting * p.pgBackupGBMonth; // lands in backup storage for the retention window
const costStorageGrowthMonth = dbGrowthGBPerSitting * p.pgStorageGBMonth; // recurring, per month, per sitting kept hot
const costMediaStorageMonth = mediaGBPerSitting * p.blobHotGBMonth;
const costMediaArchiveMonth = mediaGBPerSitting * p.blobArchiveGBMonth;
const costPerSitting = costApiBurst + costPgBurst + costMediaNodes + costEgress + costWal + costStorageGrowthMonth + costMediaStorageMonth;

// --- Year ---------------------------------------------------------------------
const studentHoursPerYear = input.totalStudents * input.examHoursPerStudentYear;
const sittingsPerYear = Math.ceil(studentHoursPerYear / (S * input.hours));
const baselineMonth = p.apiBaseNodeHour * 730 + p.pgBaseHour * 730 + p.redisMonth + p.monitoringMonth + p.loadBalancerMonth + 128 * p.pgStorageGBMonth;
const licencesYear = input.tenants * p.powerAutomatePremiumUserMonth * 12;
const burstYear = sittingsPerYear * costPerSitting;
const dbGrowthGBYear = sittingsPerYear * dbGrowthGBPerSitting;
const storageGrowthYear = dbGrowthGBYear * p.pgStorageGBMonth * 6; // average 6 months in the year, then archived
const mediaYearGB = sittingsPerYear * mediaGBPerSitting;
const mediaStorageYear = mediaYearGB * p.blobHotGBMonth * 2 + mediaYearGB * p.blobArchiveGBMonth * 10; // 60 days hot, then archive
const totalYear = baselineMonth * 12 + burstYear + licencesYear + storageGrowthYear + mediaStorageYear;

// --- Mail quotas ----------------------------------------------------------------
const mailsPerSitting = S * 4; // hall ticket, admission receipt, submission receipt, result
const exchangeMinutesAt30PerMin = S / 30; // one bulk wave at the Exchange Online message rate limit
const acsCostPerSitting = mailsPerSitting * p.acsEmail;

const out = {
  input,
  rates: {
    savesPerSec: r(savesPerSec),
    savesPerSecWorst: r(savesPerSecWorst),
    heartbeatsPerSec: r(heartbeatsPerSec),
    proctorEventsPerSec: r(eventsPerSec),
    steadyReqPerSec: r(steadyReqPerSec),
    steadyReqPerSecWorst: r(steadyReqPerSecWorst),
    precheckWindowReqPerSec: r(precheckReqPerSec),
    admitBurstPerSec: r(admitBurstPerSec),
    submitBurstPerSec: r(submitBurstPerSec),
  },
  database: {
    rowWritesPerSec: r(rowWritesPerSec),
    walMBPerSec: r(walBytesPerSec / 1e6, 2),
    walGBPerSitting: r(walGBPerSitting, 2),
    growthGBPerSitting: r(dbGrowthGBPerSitting, 2),
    growthMBPerStudentPerSitting: r((dbGrowthBytesPerSitting / S) / 1e6, 2),
    growthGBPerYear: r(dbGrowthGBYear, 1),
    growthGBPer10Years: r(dbGrowthGBYear * 10, 0),
  },
  network: {
    perStudentKbps: r(perStudentKbps, 1),
    aggregateMbpsNoMedia: r(aggregateMbps, 1),
    admissionBurstMbps: r(admissionBurstMbps, 0),
    paperDownloadGB: r(paperGB, 2),
    egressGBPerSitting: r(egressGBPerSitting, 2),
    mediaTier: input.mediaTier,
    mediaIngestMbps: r(mediaIngestMbps, 0),
    mediaGBPerSitting: r(mediaGBPerSitting, 1),
  },
  sizing: {
    apiNodes: `${apiNodes} × 4 vCPU / 16 GB (burst, plus the always-on baseline node)`,
    postgres: pgTier,
    pgbouncerConnections: apiNodes * 20,
    redis: '1 GB is ample (sessions, rate limits, grants)',
    mediaNodes,
  },
  costUsd: {
    perSitting: r(costPerSitting, 2),
    perSittingBreakdown: {
      apiBurstNodes: r(costApiBurst, 2),
      pgScaleUp: r(costPgBurst, 2),
      mediaNodes: r(costMediaNodes, 2),
      egress: r(costEgress, 2),
      walBackup: r(costWal, 2),
      storageGrowthPerMonth: r(costStorageGrowthMonth, 3),
      mediaStoragePerMonthHot: r(costMediaStorageMonth, 2),
      mediaStoragePerMonthArchive: r(costMediaArchiveMonth, 3),
    },
    perStudentPerSitting: r(costPerSitting / S, 4),
    perStudentHour: r(costPerSitting / (S * input.hours), 4),
    baselinePerMonth: r(baselineMonth, 0),
    year: {
      sittingsPerYear,
      baseline: r(baselineMonth * 12, 0),
      burst: r(burstYear, 0),
      licences: r(licencesYear, 0),
      storageGrowth: r(storageGrowthYear, 0),
      mediaStorage: r(mediaStorageYear, 0),
      total: r(totalYear, 0),
      totalInrApprox: r(totalYear * input.usdToInr, 0),
      perStudentPerYear: r(totalYear / input.totalStudents, 2),
    },
  },
  mail: {
    mailsPerSitting,
    exchangeOneWaveMinutesAt30PerMin: r(exchangeMinutesAt30PerMin, 0),
    exchangeDailyRecipientCapPerMailbox: 10000,
    exchangeExternalRecipientCapPerMailbox: 2000,
    acsFallbackCostPerSittingUsd: r(acsCostPerSitting, 2),
  },
};

function r(x, d = 1) {
  return Number(x.toFixed(d));
}

if (args.json) {
  console.log(JSON.stringify(out, null, 2));
} else {
  const line = (k, v) => console.log(`${k.padEnd(44)} ${v}`);
  console.log(`\nSMRU ExamOS capacity model — ${S} concurrent students × ${input.hours} h, media tier ${input.mediaTier}\n`);
  console.log('Request rates (steady, during writing)');
  line('  answer saves /s (realistic / worst)', `${out.rates.savesPerSec} / ${out.rates.savesPerSecWorst}`);
  line('  heartbeats /s', out.rates.heartbeatsPerSec);
  line('  proctor signals /s', out.rates.proctorEventsPerSec);
  line('  total /s (realistic / worst)', `${out.rates.steadyReqPerSec} / ${out.rates.steadyReqPerSecWorst}`);
  line('  readiness window /s', out.rates.precheckWindowReqPerSec);
  line('  admission burst /s (2 min)', out.rates.admitBurstPerSec);
  line('  submit burst /s (last 5 min)', out.rates.submitBurstPerSec);
  console.log('\nDatabase');
  line('  row writes /s (worst)', out.database.rowWritesPerSec);
  line('  WAL MB/s · GB per sitting', `${out.database.walMBPerSec} · ${out.database.walGBPerSitting}`);
  line('  growth GB per sitting', out.database.growthGBPerSitting);
  line('  growth MB per student per sitting', out.database.growthMBPerStudentPerSitting);
  line('  growth GB per year / 10 years', `${out.database.growthGBPerYear} / ${out.database.growthGBPer10Years}`);
  console.log('\nNetwork');
  line('  per student kbps (no media)', out.network.perStudentKbps);
  line('  aggregate Mbps (no media)', out.network.aggregateMbpsNoMedia);
  line('  admission burst Mbps (paper, 2 min)', out.network.admissionBurstMbps);
  line('  egress GB per sitting', out.network.egressGBPerSitting);
  line('  media ingest Mbps · GB per sitting', `${out.network.mediaIngestMbps} · ${out.network.mediaGBPerSitting}`);
  console.log('\nSizing');
  line('  API nodes (burst)', out.sizing.apiNodes);
  line('  PostgreSQL (exam day)', out.sizing.postgres);
  line('  pooled DB connections', out.sizing.pgbouncerConnections);
  line('  media nodes', out.sizing.mediaNodes);
  console.log('\nCost (USD, Azure Central India list prices — estimates)');
  line('  per sitting (exam day)', `$${out.costUsd.perSitting}`);
  line('    api burst / pg scale-up / egress', `$${out.costUsd.perSittingBreakdown.apiBurstNodes} / $${out.costUsd.perSittingBreakdown.pgScaleUp} / $${out.costUsd.perSittingBreakdown.egress}`);
  line('  per student per sitting', `$${out.costUsd.perStudentPerSitting}`);
  line('  per student-hour', `$${out.costUsd.perStudentHour}`);
  line('  baseline per month (always on)', `$${out.costUsd.baselinePerMonth}`);
  line(`  year: ${out.costUsd.year.sittingsPerYear} sittings → total`, `$${out.costUsd.year.total}  (≈ ₹${out.costUsd.year.totalInrApprox.toLocaleString('en-IN')} at ${input.usdToInr}/USD)`);
  line('    baseline / burst / licences', `$${out.costUsd.year.baseline} / $${out.costUsd.year.burst} / $${out.costUsd.year.licences}`);
  line('    storage growth / media storage', `$${out.costUsd.year.storageGrowth} / $${out.costUsd.year.mediaStorage}`);
  line('  per enrolled student per year', `$${out.costUsd.year.perStudentPerYear}`);
  console.log('\nMail quotas (Exchange Online shared mailbox via Power Automate)');
  line('  mails per sitting (4 per student)', out.mail.mailsPerSitting);
  line('  one 1,000-mail wave at 30/min', `${out.mail.exchangeOneWaveMinutesAt30PerMin} min`);
  line('  daily recipient cap / external cap', `${out.mail.exchangeDailyRecipientCapPerMailbox} / ${out.mail.exchangeExternalRecipientCapPerMailbox} per mailbox`);
  line('  ACS Email fallback per sitting', `$${out.mail.acsFallbackCostPerSittingUsd}`);
  console.log('');
}
