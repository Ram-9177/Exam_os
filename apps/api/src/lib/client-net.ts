import type { Request } from 'express';

/** Network facts about the caller, as Express resolved them (`trust proxy` decides whether X-Forwarded-For counts). */
export interface ClientNet {
  ip: string | null;
  userAgent: string | null;
}

export function normaliseIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const clean = ip.trim().replace(/^::ffff:/i, '');
  return clean.length ? clean.slice(0, 64) : null;
}

export function clientNet(req: Request): ClientNet {
  return {
    ip: normaliseIp(req.ip ?? req.socket?.remoteAddress ?? null),
    userAgent: (req.get('user-agent') ?? '').slice(0, 512) || null,
  };
}
