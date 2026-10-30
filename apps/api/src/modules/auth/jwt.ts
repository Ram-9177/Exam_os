import { SignJWT, jwtVerify, importPKCS8, importSPKI, exportJWK, type KeyLike, type JWTPayload } from 'jose';
import type { Config } from '../../config.js';

export interface AccessClaims extends JWTPayload {
  sub: string; // user id
  tid: string; // tenant id
  sfm: string; // session family id
  jti: string;
}

/**
 * RS256 access tokens (spec §19, review §2 item 12): short-lived, carry no
 * roles or permissions. Authorisation is re-read from role_grants per request.
 */
export class JwtService {
  private privateKey!: KeyLike;
  private publicKey!: KeyLike;
  private constructor(private readonly config: Config) {}

  static async create(config: Config): Promise<JwtService> {
    const svc = new JwtService(config);
    svc.privateKey = await importPKCS8(config.jwtPrivateKeyPem, 'RS256');
    svc.publicKey = await importSPKI(config.jwtPublicKeyPem, 'RS256');
    return svc;
  }

  async signAccessToken(input: { userId: string; tenantId: string; sessionFamilyId: string; jti: string; now?: Date }): Promise<string> {
    const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
    return new SignJWT({ tid: input.tenantId, sfm: input.sessionFamilyId })
      .setProtectedHeader({ alg: 'RS256', kid: this.config.JWT_KID, typ: 'JWT' })
      .setSubject(input.userId)
      .setJti(input.jti)
      .setIssuer(this.config.JWT_ISSUER)
      .setAudience(this.config.JWT_AUDIENCE)
      .setIssuedAt(now)
      .setNotBefore(now - 5)
      .setExpirationTime(now + this.config.JWT_ACCESS_TTL_SECONDS)
      .sign(this.privateKey);
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, this.publicKey, {
      issuer: this.config.JWT_ISSUER,
      audience: this.config.JWT_AUDIENCE,
      algorithms: ['RS256'],
      clockTolerance: 5,
    });
    if (typeof payload.sub !== 'string' || typeof payload['tid'] !== 'string' || typeof payload['sfm'] !== 'string' || typeof payload.jti !== 'string') {
      throw new Error('malformed access token');
    }
    return payload as AccessClaims;
  }

  async jwks(): Promise<{ keys: Record<string, unknown>[] }> {
    const jwk = await exportJWK(this.publicKey);
    return { keys: [{ ...jwk, kid: this.config.JWT_KID, use: 'sig', alg: 'RS256' }] };
  }
}
