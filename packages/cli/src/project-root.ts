import { existsSync } from 'node:fs'
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
