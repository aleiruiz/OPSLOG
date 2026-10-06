import { createHmac, timingSafeEqual } from 'node:crypto';
import { FileError } from '../../../domain/files/src/index.js';

/** FR-134: download grants expire in at most 15 minutes. */
export const MAX_GRANT_TTL_SECONDS = 15 * 60;
export const DEFAULT_GRANT_TTL_SECONDS = 5 * 60;

export interface GrantClaims {
  readonly tenantId: string;
  readonly fileId: string;
  readonly subject: string;
}

export interface IssuedGrant {
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * HMAC-signed short-lived grant binding tenant, file and actor. It only proves that the proxy
 * issued it recently; the proxy still re-checks session, permissions and file status on use.
 */
export class DownloadGrants {
  private readonly key: Buffer;
  public constructor(
    secret: string,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlSeconds: number = DEFAULT_GRANT_TTL_SECONDS,
  ) {
    if (typeof secret !== 'string' || secret.length < 32) throw new FileError('invalid_input');
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_GRANT_TTL_SECONDS)
      throw new FileError('invalid_input');
    this.key = Buffer.from(secret, 'utf8');
  }
  private sign(payload: string): Buffer {
    return createHmac('sha256', this.key).update(payload).digest();
  }
  public issue(claims: GrantClaims): IssuedGrant {
    const expiresAt = new Date(this.now().getTime() + this.ttlSeconds * 1000);
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        t: claims.tenantId,
        f: claims.fileId,
        s: claims.subject,
        e: expiresAt.getTime(),
      }),
    ).toString('base64url');
    return { token: `${payload}.${this.sign(payload).toString('base64url')}`, expiresAt };
  }
  public verify(token: unknown): GrantClaims {
    if (typeof token !== 'string') throw new FileError('unauthorized');
    const parts = token.split('.');
    const [payload, signature] = parts;
    if (parts.length !== 2 || !payload || !signature) throw new FileError('unauthorized');
    const expected = this.sign(payload);
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      throw new FileError('unauthorized');
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw new FileError('unauthorized');
    }
    const c = parsed as Record<string, unknown> | null;
    if (
      !c ||
      c.v !== 1 ||
      typeof c.t !== 'string' ||
      typeof c.f !== 'string' ||
      typeof c.s !== 'string' ||
      typeof c.e !== 'number' ||
      c.e <= this.now().getTime()
    )
      throw new FileError('unauthorized');
    return { tenantId: c.t, fileId: c.f, subject: c.s };
  }
}
