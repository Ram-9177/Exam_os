import type { Knex } from '@examos/db';
import type { ScreenFrameUpload } from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { AppError } from '../../lib/errors.js';
import { sha256Hex } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { getDocumentStorage } from '../documents/storage.js';
import { assertDeviceSession, screenWatchOf } from '../attempts/service.js';

const MAX_FRAME_BYTES = 400 * 1024;
const BUCKET = 'screens';

/**
 * Screen watch. While an exam with screen watch is live, the student's workspace sends a small JPEG of the shared
 * screen every intervalSeconds. Only the student's own live attempt, from the admitted device, and only when the exam
 * turns it on. The arrival time is the server's: gaps are measured here, never taken from the client.
 */
export async function uploadScreenFrame(deps: AppDeps, trx: Knex.Transaction, tenantId: string, userId: string, attemptId: string, deviceSession: string | null, input: ScreenFrameUpload) {
  const attempt = await trx('exam_attempts').where({ tenant_id: tenantId, id: attemptId }).forNoKeyUpdate().first();
  if (!attempt || attempt.user_id !== userId) throw AppError.notFound('ATTEMPT_NOT_FOUND');
  if (attempt.status !== 'ACTIVE') throw AppError.conflict('ATTEMPT_STATE', `attempt is ${attempt.status}`);
  await assertDeviceSession(deps, trx, tenantId, attempt, deviceSession);
  const exam = await trx('exams').where({ tenant_id: tenantId, id: attempt.exam_id }).first('policy');
  if (!screenWatchOf((exam?.policy ?? {}) as Record<string, unknown>)) throw AppError.conflict('SCREEN_WATCH_OFF', 'This exam does not use screen watch');
  const data = Buffer.from(input.image.slice(input.image.indexOf(',') + 1), 'base64');
  if (data.length > MAX_FRAME_BYTES) throw AppError.badRequest('FRAME_TOO_LARGE', 'Screen picture larger than 400 KB');
  // the bytes must be a JPEG, whatever the data URL says
  if (!(data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)) throw AppError.badRequest('INVALID_IMAGE', 'Screen picture is not a JPEG');
  const sha256 = sha256Hex(data);
  const key = `${attemptId}_${Date.now()}_${sha256.slice(0, 12)}.jpg`;
  await getDocumentStorage().putObject(tenantId, BUCKET, key, data, 'image/jpeg');
  const [row] = await trx('screen_frames')
    .insert({ tenant_id: tenantId, attempt_id: attemptId, object_key: key, sha256, byte_length: data.length, width: input.width, height: input.height, display_surface: input.displaySurface })
    .returning(['id', 'received_at']);
  return { frameId: row.id as string, receivedAt: new Date(row.received_at).toISOString() };
}

/** For proctors: the pictures of one attempt, newest first, and how long since the last one arrived (server clock). */
export async function listScreenFrames(deps: AppDeps, trx: Knex.Transaction, tenantId: string, actorId: string, attemptId: string, requestId?: string) {
  const attempt = await trx('exam_attempts').where({ tenant_id: tenantId, id: attemptId }).first('id', 'exam_id', 'status');
  if (!attempt) throw AppError.notFound('ATTEMPT_NOT_FOUND');
  const exam = await trx('exams').where({ tenant_id: tenantId, id: attempt.exam_id }).first('policy');
  const watch = screenWatchOf((exam?.policy ?? {}) as Record<string, unknown>);
  const rows = await trx('screen_frames').where({ tenant_id: tenantId, attempt_id: attemptId }).orderBy('received_at', 'desc').limit(300).select('id', 'received_at', 'display_surface', 'width', 'height');
  const now = deps.clock.now().getTime();
  const last = rows[0] ? new Date(rows[0].received_at).getTime() : null;
  // gaps between consecutive pictures longer than twice the interval (sharing stopped, device offline, page closed)
  const gaps: Array<{ from: string; to: string; seconds: number }> = [];
  if (watch) {
    for (let i = 0; i + 1 < rows.length; i++) {
      const later = new Date(rows[i].received_at).getTime();
      const earlier = new Date(rows[i + 1].received_at).getTime();
      if (later - earlier > watch.intervalSeconds * 2000) gaps.push({ from: new Date(earlier).toISOString(), to: new Date(later).toISOString(), seconds: Math.round((later - earlier) / 1000) });
    }
  }
  // looking at a student's screen is itself recorded
  await audit(trx, { tenantId, actorType: 'USER', actorId, action: 'proctor.screen_frames_viewed', entityType: 'exam_attempt', entityId: attemptId, requestId, metadata: { frames: rows.length } });
  return {
    enabled: !!watch,
    intervalSeconds: watch?.intervalSeconds ?? null,
    lastFrameAt: last ? new Date(last).toISOString() : null,
    // server-observed: only meaningful while the attempt is live
    secondsSinceLastFrame: attempt.status === 'ACTIVE' && last ? Math.round((now - last) / 1000) : null,
    overdue: !!watch && attempt.status === 'ACTIVE' && (last === null || now - last > watch.intervalSeconds * 2000),
    gaps,
    frames: rows.map((r) => ({ id: r.id as string, receivedAt: new Date(r.received_at).toISOString(), displaySurface: r.display_surface as string, entireScreen: r.display_surface === 'monitor', width: r.width as number, height: r.height as number })),
  };
}

export async function screenFrameImage(trx: Knex.Transaction, tenantId: string, frameId: string) {
  const row = await trx('screen_frames').where({ tenant_id: tenantId, id: frameId }).first('object_key');
  if (!row) throw AppError.notFound('FRAME_NOT_FOUND');
  const obj = await getDocumentStorage().getObject(tenantId, BUCKET, row.object_key);
  if (!obj) throw AppError.notFound('FRAME_NOT_FOUND', 'The picture is no longer stored');
  return obj.data;
}
