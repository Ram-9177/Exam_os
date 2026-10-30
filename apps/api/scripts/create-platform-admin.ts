/**
 * Creates the single platform super admin (one per deployment) and prints the
 * TOTP enrolment URI once. Run on the server by university IT:
 *
 *   npm run platform:create-admin -w @examos/api -- --email it-head@smru.edu.in
 *
 * The password is read from PLATFORM_ADMIN_PASSWORD (never a CLI argument, so
 * it does not land in shell history). Refuses to run when a super admin already
 * exists; `--rotate` replaces the password and TOTP secret of the existing one
 * and revokes all of its sessions.
 */
import bcrypt from 'bcrypt';
import { buildDeps, closeDeps } from '../src/deps.js';
import { newTotpSecret } from '../src/modules/platform/totp.js';
import { audit } from '../src/lib/audit.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg('email')?.trim().toLowerCase();
  const rotate = process.argv.includes('--rotate');
  const password = process.env['PLATFORM_ADMIN_PASSWORD'] ?? '';
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('--email <address> is required');
  if (password.length < 14 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    throw new Error('PLATFORM_ADMIN_PASSWORD must be at least 14 characters with upper, lower, digit and symbol');
  }
  const deps = buildDeps();
  try {
    const secret = newTotpSecret();
    const hash = await bcrypt.hash(password, 12);
    await deps.db.transaction(async (trx) => {
      const existing = await trx('platform_admins').where({ singleton: true }).forNoKeyUpdate().first();
      if (existing && !rotate) throw new Error('A platform super admin already exists. Use --rotate to replace its credentials.');
      if (existing) {
        await trx('platform_admins').where('id', existing.id).update({ email, password_hash: hash, totp_secret_ref: deps.secrets.seal(secret), last_totp_step: -1, failed_attempts: 0, locked_until: null });
        await trx('platform_sessions').where('admin_id', existing.id).whereNull('revoked_at').update({ revoked_at: trx.fn.now() });
        await audit(trx, { tenantId: null, actorType: 'PLATFORM', actorId: existing.id, action: 'platform.admin_rotated', entityType: 'platform_admin', entityId: existing.id, metadata: { email } });
      } else {
        const [row] = await trx('platform_admins').insert({ email, password_hash: hash, totp_secret_ref: deps.secrets.seal(secret) }).returning('id');
        await audit(trx, { tenantId: null, actorType: 'PLATFORM', actorId: row.id, action: 'platform.admin_created', entityType: 'platform_admin', entityId: row.id, metadata: { email } });
      }
    });
    const issuer = encodeURIComponent('SMRU ExamOS');
    process.stdout.write(`Super admin ${email} is ready.\nAdd this to an authenticator app now (shown once):\n  otpauth://totp/${issuer}:${encodeURIComponent(email)}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30\n`);
  } finally {
    await closeDeps(deps);
  }
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
