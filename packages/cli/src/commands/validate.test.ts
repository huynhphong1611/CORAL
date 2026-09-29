import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createProgram } from '../program'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const fixture = (path: string) => join(root, 'fixtures/testcases', path)

async function coral(args: string[]) {
  let out = ''
  let err = ''
  let code: number | undefined
  const program = createProgram({
    out: (t) => (out += t),
    err: (t) => (err += t),
    setExitCode: (c) => (code = c),
  })
    .exitOverride()
    .configureOutput({ writeOut: (t) => (out += t), writeErr: (t) => (err += t) })
  try {
    await program.parseAsync(args, { from: 'user' })
  } catch (error) {
    code = (error as { exitCode?: number }).exitCode ?? 2
  }
  return { out, err, code }
}

let tmp = ''
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'coral-validate-'))
})
afterAll(() => rm(tmp, { recursive: true, force: true }))

describe('coral validate', () => {
  it('exits 0 for valid test cases and popups', async () => {
    const result = await coral([
      'validate',
      fixture('valid/all-actions.yaml'),
      fixture('valid/cross-platform.yaml'),
      join(root, 'examples/popups.example.yaml'),
    ])
    expect(result.code).toBe(0)
    expect(result.out).toBe('3 files, 0 errors, 0 warnings\n')
  })

  it('accepts the My Demo App reference test cases run on emulators', async () => {
    const result = await coral([
      'validate',
      fixture('mydemo-login.yaml'),
      fixture('mydemo-camera-permission.yaml'),
    ])
    expect(result).toMatchObject({ code: 0, out: '2 files, 0 errors, 0 warnings\n' })
  })

  it('prints file:line:column  step_id  path  code  message and exits 1', async () => {
    const file = fixture('invalid/point-pct-not-last.yaml')
    const result = await coral(['validate', file])
    expect(result.code).toBe(1)
    expect(result.out.split('\n')[0]).toBe(
      `${file}:9:9  s1  steps[0].target[0]  point_pct_not_last  point_pct is the last resort and must be the last locator (P2)`,
    )
    expect(result.out).toContain('no_expect_after_tap')
    expect(result.out).toContain('1 files, 1 errors, 1 warnings')
  })

  it('prints JSON with --format json', async () => {
    const file = fixture('invalid/duplicate-step-id.yaml')
    const result = await coral(['validate', '--format', 'json', file])
    expect(result.code).toBe(1)
    const body = JSON.parse(result.out) as {
      files: { valid: boolean; errors: { code: string }[] }[]
    }
    expect(body.files[0]?.valid).toBe(false)
    expect(body.files[0]?.errors.map((e) => e.code)).toEqual(['duplicate_step_id'])
  })

  it('keeps exit code 0 with warnings only', async () => {
    const file = join(tmp, 'warn.yaml')
    await writeFile(
      file,
      "schema: coral/testcase@1\nid: warn\nintent: x\nplatforms: [android]\nsteps:\n  - id: s1\n    action: tap\n    target: [{ text: 'Go' }]\n",
    )
    const result = await coral(['validate', file])
    expect(result.code).toBe(0)
    expect(result.out).toContain('no_expect_after_tap')
    expect(result.out).toContain('(warning)')
  })

  it('rejects files with an unknown schema', async () => {
    const file = join(tmp, 'other.yaml')
    await writeFile(file, 'schema: coral/other@9\n')
    const result = await coral(['validate', file])
    expect(result.code).toBe(1)
    expect(result.out).toContain(`${file}:1:1  -  schema  schema  unknown schema`)
  })

  it('exits 2 for unreadable files and bad options', async () => {
    expect((await coral(['validate', join(tmp, 'missing.yaml')])).code).toBe(2)
    expect(
      (await coral(['validate', '--format', 'xml', fixture('valid/all-actions.yaml')])).code,
    ).not.toBe(0)
    expect((await coral(['validate'])).code).toBe(2)
  })
})
