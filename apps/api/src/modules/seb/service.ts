import type { Knex } from '@examos/db';
import type { AppDeps } from '../../types.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { buildSebSettings, sebConfigKey as sebConfigKey_, sebSettingsToPlist } from './settings.js';
import type { SebConfigGenerateInput, ExamClientPolicyUpdate } from '@examos/contracts';

/** Changing the SEB configuration or keys once students can be inside the exam would lock every one of them out. */
const SEB_FROZEN_STATUSES = ['LIVE', 'CLOSED', 'ARCHIVED', 'CANCELLED'];

export async function generateSebConfig(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  examId: string,
  origin: string,
  actorId: string,
  input: SebConfigGenerateInput
): Promise<{ sebConfigKey: string; generatedAt: string; downloadUrl: string; xml: string; prohibitedApps: number }> {
  const exam = await trx('exams')
    .where({ tenant_id: tenantId, id: examId })
    .forNoKeyUpdate()
    .first();
  if (!exam) throw AppError.notFound('EXAM_NOT_FOUND', 'Exam not found');
  if (SEB_FROZEN_STATUSES.includes(exam.status)) throw AppError.conflict('SEB_CONFIG_FROZEN', `The Safe Exam Browser configuration cannot change while the exam is ${exam.status}`);
  if (exam.security_profile !== 'SECURE_BYOD') throw AppError.conflict('SEB_NOT_APPLICABLE', 'Safe Exam Browser applies to SECURE_BYOD exams; change the security profile first');

  const settings = buildSebSettings({
    origin,
    allowQuit: input.allowQuit,
    quitPassword: input.quitPassword,
    kioskMode: input.kioskMode,
    blockVirtualMachines: input.blockVirtualMachines,
    blockScreenCapture: input.blockScreenCapture,
    blockClipboard: input.blockClipboard,
    extraProhibited: input.prohibitedProcesses,
  });
  const xml = sebSettingsToPlist(settings);
  const sebConfigKey = sebConfigKey_(settings);
  const prohibitedApps = Array.isArray(settings['prohibitedProcesses']) ? settings['prohibitedProcesses'].length : 0;
  const now = deps.clock.now().toISOString();

  const existingPolicy = (exam.policy ?? {}) as Record<string, unknown>;
  const updatedPolicy = {
    ...existingPolicy,
    sebConfigKey,
    sebConfigXml: xml,
    sebGeneratedAt: now,
    sebOrigin: origin,
    sebKioskMode: input.kioskMode,
    sebBlockVm: input.blockVirtualMachines,
    sebQuitPasswordSet: !!input.quitPassword,
    sebExtraProhibited: input.prohibitedProcesses ?? [],
  };

  await trx('exams')
    .where({ tenant_id: tenantId, id: examId })
    .update({ policy: updatedPolicy, updated_at: trx.fn.now() });

  await audit(trx, {
    tenantId,
    actorType: 'USER',
    actorId,
    action: 'seb_config.generated',
    entityType: 'exam',
    entityId: examId,
    metadata: { sebConfigKey, origin, kioskMode: input.kioskMode, blockVm: input.blockVirtualMachines, prohibitedApps, quitPasswordSet: !!input.quitPassword },
  });

  return { sebConfigKey, generatedAt: now, downloadUrl: `/api/v1/exams/${examId}/seb-config`, xml, prohibitedApps };
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

  // A download is a read. Generating the configuration rewrites the exam policy (and switches the CLIENT_VERSION
  // check to the Config Key path), which only an exams:write holder may do through POST /exams/:id/seb-config.
  if (!xml || !sebConfigKey) throw AppError.notFound('SEB_CONFIG_NOT_GENERATED', 'The Safe Exam Browser configuration for this exam has not been generated yet; the Examination Section generates it first');

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
  const touchesSeb = input.sebConfigKey !== undefined || input.sebBrowserExamKeys !== undefined || input.requireManagedEndpoint !== undefined;
  if (touchesSeb && SEB_FROZEN_STATUSES.includes(exam.status)) throw AppError.conflict('SEB_CONFIG_FROZEN', `Secure-client keys cannot change while the exam is ${exam.status}`);

  const existingPolicy = (exam.policy ?? {}) as Record<string, unknown>;
  const updatedPolicy = {
    ...existingPolicy,
    // A key pasted by hand (from the SEB Config Tool) replaces the generated one; the generated file no longer matches it.
    ...(input.sebConfigKey !== undefined ? { sebConfigKey: input.sebConfigKey.toLowerCase(), ...(input.sebConfigKey.toLowerCase() !== existingPolicy['sebConfigKey'] ? { sebConfigXml: null } : {}) } : {}),
    ...(input.sebBrowserExamKeys !== undefined ? { sebBrowserExamKeys: input.sebBrowserExamKeys.map((k) => k.toLowerCase()) } : {}),
    ...(input.allowedClientBuilds !== undefined ? { allowedClientBuilds: input.allowedClientBuilds } : {}),
    ...(input.requireManagedEndpoint !== undefined ? { requireManagedEndpoint: input.requireManagedEndpoint } : {}),
    ...(input.allowedSubnets !== undefined ? { allowedSubnets: input.allowedSubnets } : {}),
    ...(input.ipPolicy !== undefined ? { ipPolicy: input.ipPolicy } : {}),
    ...(input.cameraPresence !== undefined ? { proctoring: { ...((existingPolicy['proctoring'] ?? {}) as Record<string, unknown>), cameraPresence: input.cameraPresence } } : {}),
  };
  const prevCamera = ((existingPolicy['proctoring'] ?? {}) as Record<string, unknown>)['cameraPresence'] === true;
  if (input.cameraPresence !== undefined && input.cameraPresence !== prevCamera && SEB_FROZEN_STATUSES.includes(exam.status)) {
    throw AppError.conflict('POLICY_FROZEN', `Camera presence cannot change while the exam is ${exam.status}`);
  }
  // What students consent to changed: a new policy version, so readiness (and its consent) is taken again.
  const newVersion = input.cameraPresence !== undefined && input.cameraPresence !== prevCamera ? `${exam.policy_version.split('+')[0]}+cam${input.cameraPresence ? 1 : 0}-${Date.now().toString(36)}` : null;

  await trx('exams')
    .where({ tenant_id: tenantId, id: examId })
    .update({ policy: updatedPolicy, ...(newVersion ? { policy_version: newVersion } : {}), updated_at: trx.fn.now() });

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
      ipPolicy: input.ipPolicy,
      sebConfigKeySet: input.sebConfigKey !== undefined,
      sebBrowserExamKeysCount: input.sebBrowserExamKeys?.length,
      cameraPresence: input.cameraPresence,
      policyVersion: newVersion ?? undefined,
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
