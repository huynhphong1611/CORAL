import { newId } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from './password'
import {
  ACCESS_TOKEN_TTL_SEC,
  hashToken,
  newOpaqueToken,
  signAccessToken,
  verifyAccessToken,
} from './tokens'

const secret = 'x'.repeat(40)
const claims = { sub: newId(), tid: newId(), role: 'owner' as const }

describe('access tokens', () => {
  it('round-trips the claims', async () => {
    expect(await verifyAccessToken(await signAccessToken(claims, secret), secret)).toEqual(claims)
  })

  it('rejects another key, garbage and expired tokens', async () => {
    const token = await signAccessToken(claims, secret)
    expect(await verifyAccessToken(token, 'y'.repeat(40))).toBeNull()
    expect(await verifyAccessToken('not.a.jwt', secret)).toBeNull()
    const old = new Date(Date.now() - (ACCESS_TOKEN_TTL_SEC + 60) * 1000)
    expect(await verifyAccessToken(await signAccessToken(claims, secret, old), secret)).toBeNull()
  })
})

describe('opaque tokens and passwords', () => {
  it('creates prefixed random tokens and stable hashes', () => {
    const token = newOpaqueToken('coral_agt_')
    expect(token).toMatch(/^coral_agt_[A-Za-z0-9_-]{43}$/)
    expect(newOpaqueToken()).not.toBe(newOpaqueToken())
    expect(hashToken(token)).toBe(hashToken(token))
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hashes passwords with argon2id', async () => {
    const hash = await hashPassword('Mật khẩu dài')
    expect(hash).toMatch(/^\$argon2id\$/)
    expect(await verifyPassword(hash, 'Mật khẩu dài')).toBe(true)
    expect(await verifyPassword(hash, 'wrong')).toBe(false)
    expect(await verifyPassword('garbage', 'x')).toBe(false)
  })
})
