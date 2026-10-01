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

// Each case runs type-aware ESLint on a real file: seconds each, more under a parallel run.
describe('ESLint dependency boundaries', { timeout: 60_000 }, () => {
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

  it("forbids the Copilot SDK's runtime packages outside the brain (P1, D47)", async () => {
    const errors = await restrictedImportErrors(
      "import runtime from '@github/copilot-sdk-linux-x64'\nexport const x = runtime\n",
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

  it('keeps the web app off Node built-ins and the runner (browser)', async () => {
    const file = `${root}/apps/web/src/__eslint_probe__.ts`
    for (const code of [
      "import { readFileSync } from 'node:fs'\nexport const x = readFileSync\n",
      "import { resolve } from '@coral/runner'\nexport const x = resolve\n",
    ]) {
      const errors = await restrictedImportErrors(code, file)
      expect(errors.join('\n')).toContain('apps/web runs in the browser')
    }
    expect(
      await restrictedImportErrors(
        "import { parseYaml } from '@coral/shared'\nexport const x = parseYaml\n",
        file,
      ),
    ).toEqual([])
  })

  it('forbids routes from importing the database layer (constitution V)', async () => {
    const file = `${root}/apps/server/src/routes/__eslint_probe__.ts`
    const errors = await restrictedImportErrors(
      "import { sql } from 'drizzle-orm'\nimport { createDatabase } from '../db/client'\nexport const x = [sql, createDatabase]\n",
      file,
    )
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('Constitution V')
  })

  it('lets route integration tests inspect the database', async () => {
    const file = `${root}/apps/server/src/routes/__eslint_probe__.test.ts`
    const errors = await restrictedImportErrors(
      "import { sql } from 'drizzle-orm'\nexport const x = sql\n",
      file,
    )
    expect(errors).toEqual([])
  })
})
