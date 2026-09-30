import { describe, expect, it } from 'vitest'
import { healthResponseSchema } from './health'

describe('healthResponseSchema', () => {
  it('accepts a valid health payload', () => {
    const payload = { status: 'ok', service: 'coral-server', version: '0.1.0', uptime_sec: 1.5 }
    expect(healthResponseSchema.parse(payload)).toEqual(payload)
  })

  it('rejects a payload from another service or with a bad status', () => {
    expect(
      healthResponseSchema.safeParse({
        status: 'ok',
        service: 'something-else',
        version: '1',
        uptime_sec: 0,
      }).success,
    ).toBe(false)
    expect(
      healthResponseSchema.safeParse({
        status: 'down',
        service: 'coral-server',
        version: '1',
        uptime_sec: 0,
      }).success,
    ).toBe(false)
  })

  it('rejects camelCase fields (wire format is snake_case)', () => {
    expect(
      healthResponseSchema.safeParse({
        status: 'ok',
        service: 'coral-server',
        version: '1',
        uptimeSec: 0,
      }).success,
    ).toBe(false)
  })
})
