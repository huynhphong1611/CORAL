import { createHash, randomBytes } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { z } from 'zod'

export const ACCESS_TOKEN_TTL_SEC = 15 * 60
export const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60

export const accessClaimsSchema = z.object({
  sub: z.uuid(),
  tid: z.uuid(),
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
})
export type AccessClaims = z.infer<typeof accessClaimsSchema>

const key = (secret: string) => new TextEncoder().encode(secret)

export function signAccessToken(
  claims: AccessClaims,
  secret: string,
  now = new Date(),
): Promise<string> {
  return new SignJWT({ tid: claims.tid, role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(now.getTime() / 1000) + ACCESS_TOKEN_TTL_SEC)
    .setIssuer('coral')
    .sign(key(secret))
}

/** Returns the claims, or null when the token is invalid or expired. */
export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      issuer: 'coral',
      algorithms: ['HS256'],
    })
    const parsed = accessClaimsSchema.safeParse(payload)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Like verifyAccessToken, plus when the token expires (epoch ms) — for long-lived sockets. */
export async function verifyAccessSession(
  token: string,
  secret: string,
): Promise<(AccessClaims & { expiresAt: number }) | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      issuer: 'coral',
      algorithms: ['HS256'],
    })
    const parsed = accessClaimsSchema.safeParse(payload)
    if (!parsed.success || typeof payload.exp !== 'number') return null
    return { ...parsed.data, expiresAt: payload.exp * 1000 }
  } catch {
    return null
  }
}

/** Opaque high-entropy token (refresh tokens, agent tokens); store only its hash. */
export function newOpaqueToken(prefix = ''): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
