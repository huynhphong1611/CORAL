import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

async function restrictedImportErrors(code: string, filePath: string): Promise<string[]> {
  // Type-aware linting only sees files that exist on disk, so write a real temporary file.
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, code)
  try {
    const eslint = new ESLint({ cwd: root })
    const [result] = await eslint.lintFiles([filePath])
    return (result?.messages ?? [])
      .filter((m) => m.ruleId === 'no-restricted-imports')
      .map((m) => m.message)
  } finally {
    rmSync(filePath)
  }
}

describe('ESLint dependency boundaries', () => {
  const coreFile = `${root}/packages/runner/src/core/__eslint_probe__.ts`

  it('forbids driver code in the runner core (D28)', async () => {
    const errors = await restrictedImportErrors(
      "import { adb } from '../../drivers/android/adb'\nexport const x = adb\n",
      coreFile,
    )
    expect(errors.join('\n')).toContain('D28')
  })

  it('forbids process and socket modules in the runner core (D28)', async () => {
    const errors = await restrictedImportErrors(
      "import { execFile } from 'node:child_process'\nexport const x = execFile\n",
      coreFile,
    )
    expect(errors).toHaveLength(1)
  })

  it('still forbids LLM SDKs in the runner core (P1)', async () => {
    const errors = await restrictedImportErrors(
      "import OpenAI from 'openai'\nexport const x = OpenAI\n",
      coreFile,
    )
    expect(errors.join('\n')).toContain('P1')
  })

  it('allows drivers to use child_process', async () => {
    const errors = await restrictedImportErrors(
      "import { execFile } from 'node:child_process'\nexport const x = execFile\n",
      `${root}/packages/runner/src/drivers/__eslint_probe__.ts`,
    )
    expect(errors).toEqual([])
  })
})
