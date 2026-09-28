import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { elementTreeSchema } from '@coral/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { androidTree } from '../testing/android-fixtures'
import { LocalDirSink } from './local-dir'

let out = ''
beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), 'coral-out-'))
})
afterAll(() => rm(out, { recursive: true, force: true }))

describe('LocalDirSink', () => {
  it('writes the contracts/cli.md layout', async () => {
    const sink = new LocalDirSink(out)
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
    const refs = await sink.saveStep(
      'login',
      { index: 2, id: 's3' },
      {
        screenshot: png,
        tree: androidTree('login'),
        log: 'E/AndroidRuntime: boom',
      },
    )
    const dir = join(out, 'login', '2-s3')
    expect(refs).toEqual({
      screenshot: join(dir, 'screenshot.png'),
      tree: join(dir, 'tree.json'),
      log: join(dir, 'device.log'),
    })
    expect(new Uint8Array(await readFile(refs.screenshot ?? ''))).toEqual(png)
    const tree: unknown = JSON.parse(await readFile(refs.tree ?? '', 'utf8'))
    expect(elementTreeSchema.safeParse(tree).success).toBe(true)
    expect(await readFile(refs.log ?? '', 'utf8')).toBe('E/AndroidRuntime: boom')

    await sink.saveResult({
      test_case: 'login',
      status: 'passed',
      started_at: new Date(0).toISOString(),
      duration_ms: 10,
      steps: [],
    })
    expect(JSON.parse(await readFile(join(out, 'login', 'result.json'), 'utf8'))).toMatchObject({
      status: 'passed',
    })
  })

  it('writes only the files it gets (no log on a passing step)', async () => {
    const refs = await new LocalDirSink(out).saveStep(
      'other',
      { index: 0, id: 's1' },
      {
        screenshot: Uint8Array.from([1]),
      },
    )
    expect(Object.keys(refs)).toEqual(['screenshot'])
    expect(await readdir(join(out, 'other', '0-s1'))).toEqual(['screenshot.png'])
  })
})
