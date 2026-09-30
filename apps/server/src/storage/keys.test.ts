import { newId } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { buildKey, keyBelongsTo, runItemResultKey, stepArtifactKey, stepPrefix } from './keys'

const tenant = newId()
const run = newId()
const item = newId()

describe('storage keys', () => {
  it('follows the data-model layout, always under the tenant', () => {
    const build = newId()
    expect(buildKey(tenant, build)).toBe(`${tenant}/builds/${build}.apk`)
    const prefix = stepPrefix(tenant, run, item, 3, 'login_tap')
    expect(prefix).toBe(`${tenant}/runs/${run}/${item}/3-login_tap/`)
    expect(stepArtifactKey(prefix, 'screenshot.png')).toBe(`${prefix}screenshot.png`)
    expect(runItemResultKey(tenant, run, item)).toBe(`${tenant}/runs/${run}/${item}/result.json`)
  })

  it('rejects ids that could escape the prefix', () => {
    expect(() => buildKey('../other', newId())).toThrow()
    expect(() => stepPrefix(tenant, run, item, 0, '../x')).toThrow()
    expect(() => stepPrefix(tenant, run, item, -1, 'a')).toThrow()
  })

  it('checks key ownership', () => {
    const key = runItemResultKey(tenant, run, item)
    expect(keyBelongsTo(key, tenant)).toBe(true)
    expect(keyBelongsTo(key, newId())).toBe(false)
    expect(keyBelongsTo(`${tenant}/runs/../../x`, tenant)).toBe(false)
  })
})
