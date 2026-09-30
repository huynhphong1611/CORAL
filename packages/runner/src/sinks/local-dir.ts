import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ArtifactSink,
  ItemResult,
  StepArtifactRefs,
  StepFiles,
  StepRef,
} from '../core/artifacts'

/**
 * `coral run` output (contracts/cli.md):
 * `<out>/<slug>/result.json` and `<out>/<slug>/<step_index>-<step_id>/{screenshot.png,tree.json,device.log}`.
 */
export class LocalDirSink implements ArtifactSink {
  constructor(readonly outDir: string) {}

  async saveStep(testCase: string, step: StepRef, files: StepFiles): Promise<StepArtifactRefs> {
    const dir = join(this.outDir, testCase, `${step.index}-${step.id}`)
    await mkdir(dir, { recursive: true })
    const refs: StepArtifactRefs = {}
    if (files.screenshot) {
      refs.screenshot = join(dir, 'screenshot.png')
      await writeFile(refs.screenshot, files.screenshot)
    }
    if (files.tree) {
      refs.tree = join(dir, 'tree.json')
      await writeFile(refs.tree, `${JSON.stringify(files.tree, null, 2)}\n`)
    }
    if (files.log !== undefined) {
      refs.log = join(dir, 'device.log')
      await writeFile(refs.log, files.log)
    }
    return refs
  }

  async saveResult(result: ItemResult): Promise<void> {
    const dir = join(this.outDir, result.test_case)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  }
}
