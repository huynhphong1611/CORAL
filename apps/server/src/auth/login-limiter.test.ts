import { describe, expect, it } from 'vitest'
import { LoginLimiter } from './login-limiter'

describe('LoginLimiter', () => {
  it('blocks after the maximum failures inside the window', () => {
    const limiter = new LoginLimiter(3, 1000)
    for (let i = 0; i < 3; i++) limiter.recordFailure('a@x.io', 100 + i)
    expect(limiter.isBlocked('a@x.io', 200)).toBe(true)
    expect(limiter.isBlocked('b@x.io', 200)).toBe(false)
  })

  it('forgets failures outside the window and on reset', () => {
    const limiter = new LoginLimiter(2, 1000)
    limiter.recordFailure('a@x.io', 0)
    limiter.recordFailure('a@x.io', 10)
    expect(limiter.isBlocked('a@x.io', 500)).toBe(true)
    expect(limiter.isBlocked('a@x.io', 1500)).toBe(false)
    limiter.recordFailure('a@x.io', 1600)
    limiter.recordFailure('a@x.io', 1601)
    limiter.reset('a@x.io')
    expect(limiter.isBlocked('a@x.io', 1602)).toBe(false)
  })
})
