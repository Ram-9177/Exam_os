import type { Knex } from '@examos/db';
import type { AppDeps } from '../../types.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { sha256Hex } from '../../lib/crypto.js';
import type { SebConfigGenerateInput, ExamClientPolicyUpdate } from '@examos/contracts';

export const DEFAULT_PROHIBITED_PROCESSES = [
  'discord',
  'teams',
  'skype',
  'zoom',
  'slack',
  'anydesk',
  'teamviewer',
  'chrome-remote-desktop',
  'vncviewer',
  'obs',
  'obs64',
  'camtasia',
  'snagit',
  'telegram',
  'whatsapp',
  'vmware',
  'virtualbox',
  'parallels',
  'qemu',
];

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case "'":
        return '&apos;';
      case '"':
        return '&quot;';
      default:
        return c;
    }
  });
}

export function buildSebConfigPlist(options: {
  startUrl: string;
  quitUrl: string;
  allowQuit?: boolean;
  quitPassword?: string;
  kioskMode?: boolean;
  blockVirtualMachines?: boolean;
  blockScreenCapture?: boolean;
  blockClipboard?: boolean;
  prohibitedProcesses?: string[];
}): string {
  const allowQuit = options.allowQuit ?? true;
  const kioskMode = options.kioskMode ?? true;
  const blockVm = options.blockVirtualMachines ?? true;
  const blockScreen = options.blockScreenCapture ?? true;
  const blockClipboard = options.blockClipboard ?? true;
  const processes = options.prohibitedProcesses ?? DEFAULT_PROHIBITED_PROCESSES;

  const procsXml = processes
    .map(
      (p) =>
        `    <dict>\n      <key>active</key>\n      <true/>\n      <key>currentUser</key>\n      <true/>\n      <key>description</key>\n      <string>${escapeXml(
          p
        )}</string>\n      <key>executable</key>\n      <string>${escapeXml(
          p
        )}</string>\n      <key>os</key>\n      <integer>1</integer>\n      <key>strongKill</key>\n      <true/>\n    </dict>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>originatorVersion</key>
  <string>SMRU ExamOS Safe Exam Browser Generator 1.0</string>
  <key>startURL</key>
  <string>${escapeXml(options.startUrl)}</string>
  <key>sendBrowserExamKey</key>
  <true/>
  <key>browserWindowAllowReload</key>
  <true/>
  <key>allowPreferencesWindow</key>
  <false/>
  <key>allowQuit</key>
  <${allowQuit ? 'true' : 'false'}/>
  <key>quitURL</key>
  <string>${escapeXml(options.quitUrl)}</string>
  <key>kioskMode</key>
  <${kioskMode ? 'true' : 'false'}/>
  <key>enablePrivateClipboard</key>
  <${blockClipboard ? 'true' : 'false'}/>
  <key>enablePrintScreen</key>
  <${blockScreen ? 'false' : 'true'}/>
  <key>allowPrint</key>
  <false/>
  <key>allowScreenSharing</key>
  <false/>
  <key>allowVirtualMachine</key>
  <${blockVm ? 'false' : 'true'}/>
  <key>allowRemoteSession</key>
  <false/>
  <key>prohibitedProcesses</key>
  <array>
${procsXml}
  </array>
</dict>
</plist>`;
}

export async function generateSebConfig(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  examId: string,
  host: string,
  actorId: string,
  input: SebConfigGenerateInput
): Promise<{ sebConfigKey: string; generatedAt: string; downloadUrl: string; xml: string }> {
  const exam = await trx('exams')
    .where({ tenant_id: tenantId, id: examId })
    .forNoKeyUpdate()
    .first();
  if (!exam) throw AppError.notFound('EXAM_NOT_FOUND', 'Exam not found');

  const startUrl = `https://${host}/student`;
  const quitUrl = `https://${host}/student`;

  const xml = buildSebConfigPlist({
    startUrl,
    quitUrl,
    allowQuit: input.allowQuit,
    quitPassword: input.quitPassword,
    kioskMode: input.kioskMode,
    blockVirtualMachines: input.blockVirtualMachines,
    blockScreenCapture: input.blockScreenCapture,
    blockClipboard: input.blockClipboard,
    prohibitedProcesses: input.prohibitedProcesses ?? DEFAULT_PROHIBITED_PROCESSES,
  });

  const sebConfigKey = sha256Hex(xml);
  const now = deps.clock.now().toISOString();

  const existingPolicy = (exam.policy ?? {}) as Record<string, unknown>;
  const updatedPolicy = {
    ...existingPolicy,
    sebConfigKey,
    sebConfigXml: xml,
    sebGeneratedAt: now,
    sebKioskMode: input.kioskMode,
    sebBlockVm: input.blockVirtualMachines,
  };

  await trx('exams')
    .where({ tenant_id: tenantId, id: examId })
    .update({
      policy: updatedPolicy,
    });

  await audit(trx, {
    tenantId,
    actorType: 'USER',
    actorId,
    action: 'seb_config.generated',
    entityType: 'exam',
    entityId: examId,
    metadata: {
      sebConfigKey,
      kioskMode: input.kioskMode,
      blockVm: input.blockVirtualMachines,
      processCount: (input.prohibitedProcesses ?? DEFAULT_PROHIBITED_PROCESSES).length,
    },
  });

  return {
    sebConfigKey,
    generatedAt: now,
    downloadUrl: `/api/v1/exams/${examId}/seb-config`,
    xml,
  };
}

export async function getSebConfigFile(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  examId: string,
  host: string,
  actorId: string
): Promise<{ filename: string; mimeType: string; content: Buffer; sebConfigKey: string }> {
  const exam = await trx('exams')
    .where({ tenant_id: tenantId, id: examId })
    .first();
  if (!exam) throw AppError.notFound('EXAM_NOT_FOUND', 'Exam not found');

  const policy = (exam.policy ?? {}) as Record<string, unknown>;
  let xml = typeof policy['sebConfigXml'] === 'string' ? policy['sebConfigXml'] : null;
  let sebConfigKey = typeof policy['sebConfigKey'] === 'string' ? policy['sebConfigKey'] : null;

  if (!xml || !sebConfigKey) {
    const res = await generateSebConfig(deps, trx, tenantId, examId, host, actorId, {
      allowQuit: true,
      kioskMode: true,
      blockVirtualMachines: true,
      blockScreenCapture: true,
      blockClipboard: true,
    });
    xml = res.xml;
    sebConfigKey = res.sebConfigKey;
  }

  await audit(trx, {
    tenantId,
    actorType: 'USER',
    actorId,
    action: 'seb_config.downloaded',
    entityType: 'exam',
    entityId: examId,
    metadata: { sebConfigKey },
  });

  return {
    filename: `smru-exam-${exam.code}.seb`,
    mimeType: 'application/seb',
    content: Buffer.from(xml, 'utf-8'),
    sebConfigKey,
  };
}

export async function updateExamClientPolicy(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  examId: string,
  actorId: string,
  input: ExamClientPolicyUpdate
): Promise<{ policy: Record<string, unknown> }> {
  const exam = await trx('exams')
    .where({ tenant_id: tenantId, id: examId })
    .forNoKeyUpdate()
    .first();
  if (!exam) throw AppError.notFound('EXAM_NOT_FOUND', 'Exam not found');

  const existingPolicy = (exam.policy ?? {}) as Record<string, unknown>;
  const updatedPolicy = {
    ...existingPolicy,
    ...(input.sebConfigKey !== undefined ? { sebConfigKey: input.sebConfigKey } : {}),
    ...(input.allowedClientBuilds !== undefined ? { allowedClientBuilds: input.allowedClientBuilds } : {}),
    ...(input.requireManagedEndpoint !== undefined ? { requireManagedEndpoint: input.requireManagedEndpoint } : {}),
    ...(input.allowedSubnets !== undefined ? { allowedSubnets: input.allowedSubnets } : {}),
  };

  await trx('exams')
    .where({ tenant_id: tenantId, id: examId })
    .update({ policy: updatedPolicy });

  await audit(trx, {
    tenantId,
    actorType: 'USER',
    actorId,
    action: 'exam.client_policy_updated',
    entityType: 'exam',
    entityId: examId,
    metadata: {
      allowedClientBuildsCount: input.allowedClientBuilds?.length,
      requireManagedEndpoint: input.requireManagedEndpoint,
      subnetsCount: input.allowedSubnets?.length,
    },
  });

  return { policy: updatedPolicy };
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return 0;
  }
  const p0 = parts[0] ?? 0;
  const p1 = parts[1] ?? 0;
  const p2 = parts[2] ?? 0;
  const p3 = parts[3] ?? 0;
  return ((p0 << 24) | (p1 << 16) | (p2 << 8) | p3) >>> 0;
}

export function isIpInSubnets(clientIp: string, allowedSubnets: string[]): boolean {
  if (!clientIp || !allowedSubnets || allowedSubnets.length === 0) return false;

  // Localhost aliases
  const cleanIp = clientIp.replace(/^::ffff:/, '');
  if (cleanIp === '127.0.0.1' || cleanIp === '::1' || cleanIp === 'localhost') {
    return true;
  }

  const clientInt = ipv4ToInt(cleanIp);

  for (const subnet of allowedSubnets) {
    const trimmed = subnet.trim();
    if (trimmed === cleanIp) return true;

    if (trimmed.includes('/')) {
      const parts = trimmed.split('/');
      const baseIp = parts[0];
      const maskStr = parts[1];
      if (!baseIp || !maskStr) continue;

      const maskBits = parseInt(maskStr, 10);
      if (isNaN(maskBits) || maskBits < 0 || maskBits > 32) continue;

      const baseInt = ipv4ToInt(baseIp);
      const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
      if ((clientInt & mask) === (baseInt & mask)) {
        return true;
      }
    }
  }

  return false;
}
