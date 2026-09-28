import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { U2_PINS, ensureU2Jar, sha256, type U2Pins } from './u2-assets'

const jar = new TextEncoder().encode('fake u2 jar')
const wheel = zipSync({ 'uiautomator2/__init__.py': new Uint8Array(1), [U2_PINS.jarEntry]: jar })
const pins: U2Pins = { ...U2_PINS, wheelSha256: sha256(wheel), jarSha256: sha256(jar) }

let dir = ''
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'coral-u2-'))
})
afterAll(() => rm(dir, { recursive: true, force: true }))

function fakeFetch(body: Uint8Array, status = 200) {
  const urls: string[] = []
  const fn = ((url: string) => {
    urls.push(url)
    return Promise.resolve(new Response(body, { status }))
  }) as unknown as typeof fetch
  return { fn, urls }
}

describe('ensureU2Jar', () => {
  it('downloads the pinned wheel once, verifies it and caches the jar', async () => {
    const cacheDir = join(dir, 'a')
    const { fn, urls } = fakeFetch(wheel)
    const path = await ensureU2Jar({ cacheDir, fetch: fn, pins })
    expect(path).toBe(join(cacheDir, 'u2', '0.4.0', 'u2.jar'))
    expect(new Uint8Array(await readFile(path))).toEqual(jar)
    expect(urls).toEqual([U2_PINS.wheelUrl])
    await ensureU2Jar({ cacheDir, fetch: fn, pins })
    expect(urls).toHaveLength(1)
  })

  it('rejects a tampered wheel or jar', async () => {
    const other = zipSync({ [U2_PINS.jarEntry]: new TextEncoder().encode('evil') })
    await expect(
      ensureU2Jar({ cacheDir: join(dir, 'b'), fetch: fakeFetch(other).fn, pins }),
    ).rejects.toThrow('wheel sha256 mismatch')
    await expect(
      ensureU2Jar({
        cacheDir: join(dir, 'c'),
        fetch: fakeFetch(other).fn,
        pins: { ...pins, wheelSha256: sha256(other) },
      }),
    ).rejects.toThrow('u2.jar sha256 mismatch')
  })

  it('re-downloads when the cached jar is corrupt', async () => {
    const cacheDir = join(dir, 'd')
    await ensureU2Jar({ cacheDir, fetch: fakeFetch(wheel).fn, pins })
    await writeFile(join(cacheDir, 'u2', '0.4.0', 'u2.jar'), 'broken')
    const { fn, urls } = fakeFetch(wheel)
    await ensureU2Jar({ cacheDir, fetch: fn, pins })
    expect(urls).toHaveLength(1)
  })

  it('prefers CORAL_U2_JAR but still checks it', async () => {
    const good = join(dir, 'good.jar')
    await writeFile(good, jar)
    expect(await ensureU2Jar({ jarPath: good, pins })).toBe(good)
    const bad = join(dir, 'bad.jar')
    await writeFile(bad, 'nope')
    await expect(ensureU2Jar({ jarPath: bad, pins })).rejects.toThrow('does not match')
  })

  it('explains how to work offline when the download fails', async () => {
    await expect(
      ensureU2Jar({ cacheDir: join(dir, 'e'), fetch: fakeFetch(new Uint8Array(), 503).fn, pins }),
    ).rejects.toThrow('set CORAL_U2_JAR')
  })
})
