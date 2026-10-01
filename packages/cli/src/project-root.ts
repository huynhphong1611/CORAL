import { existsSync, readFileSync } from 'node:fs'
import { appMapSchema } from '@coral/shared'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

/**
 * Where a test case's `image` paths start (research R12): `--project-root`, else the folder that
 * holds `testcases/`, else the YAML's own folder.
 */
export function projectRootOf(file: string, given?: string): string {
  if (given) return resolve(given)
  const dir = dirname(resolve(file))
  return basename(dir) === 'testcases' ? dirname(dir) : dir
}

/** The file a repo path names under `root`; undefined when it would leave the root. */
export function inRoot(root: string, path: string): string | undefined {
  const full = resolve(root, path)
  const rel = relative(root, full)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? full : undefined
}

/** `fileExists` for validation: image references must be files under the root (FR-022). */
export const fileExistsIn = (root: string) => (path: string) => {
  const full = inRoot(root, path)
  return full !== undefined && existsSync(full)
}

/** `assets` for runTestCase: the bytes of a reference image under the root. */
export const assetsIn = (root: string) => (path: string) => {
  const full = inRoot(root, path)
  if (!full) return Promise.reject(new Error(`${path} is outside the project root`))
  return readFile(full)
}

export const APPMAP_PATH = 'appmap/screens.json'

/**
 * Fingerprints of the app map under `root` (`appmap/screens.json`, D24), id → fingerprint; empty
 * when the project has no app map yet. A broken file throws.
 */
export function appMapScreensIn(root: string): Record<string, string> {
  const full = inRoot(root, APPMAP_PATH)
  if (!full || !existsSync(full)) return {}
  const parsed = appMapSchema.safeParse(JSON.parse(readFileSync(full, 'utf8')) as unknown)
  if (!parsed.success) throw new Error(`${APPMAP_PATH} is not a valid coral/appmap@1 file`)
  return Object.fromEntries(parsed.data.screens.map((s) => [s.id, s.fingerprint]))
}
