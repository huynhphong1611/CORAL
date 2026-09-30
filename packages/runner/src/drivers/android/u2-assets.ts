import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { unzipSync } from 'fflate'

/** u2.jar 0.4.0 shipped inside the `uiautomator2==3.7.0` wheel (D27, contracts/android-u2.md). */
export const U2_PINS = {
  version: '0.4.0',
  wheelUrl:
    'https://files.pythonhosted.org/packages/55/23/a5f93de8bb197ae2d2d0185c2c13d4b36ae7f18215e3e599e217f8e90e0d/uiautomator2-3.7.0-py3-none-any.whl',
  wheelSha256: '731bf4e26e35cd440cd165b399b8a4d4b795178d78b9243769e336aee6dce985',
  jarEntry: 'uiautomator2/assets/u2.jar',
  jarSha256: '0b74e83c55f443539a9f76f5ce023a51466b764b1100e4097a897053fdfc0eb6',
}
export type U2Pins = typeof U2_PINS

export class U2AssetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'U2AssetError'
  }
}

export const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

export function defaultCacheDir(): string {
  return join(homedir(), '.cache', 'coral')
}

export interface EnsureU2JarOptions {
  /** `CORAL_CACHE_DIR` (default `~/.cache/coral`). */
  cacheDir?: string
  /** `CORAL_U2_JAR`: a pre-downloaded jar (still checked against the pinned sha256). */
  jarPath?: string
  fetch?: typeof fetch
  pins?: U2Pins
}

async function readIfExists(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path))
  } catch {
    return undefined
  }
}

/**
 * Returns the path of a verified u2.jar: `CORAL_U2_JAR` if set, else the cache, else downloads the
 * pinned wheel from PyPI, checks both checksums and extracts the jar.
 */
export async function ensureU2Jar(options: EnsureU2JarOptions = {}): Promise<string> {
  const pins = options.pins ?? U2_PINS
  if (options.jarPath) {
    const jar = await readIfExists(options.jarPath)
    if (!jar) throw new U2AssetError(`CORAL_U2_JAR not readable: ${options.jarPath}`)
    if (sha256(jar) !== pins.jarSha256) {
      throw new U2AssetError(
        `CORAL_U2_JAR sha256 ${sha256(jar)} does not match u2.jar ${pins.version} (${pins.jarSha256})`,
      )
    }
    return options.jarPath
  }

  const target = join(options.cacheDir ?? defaultCacheDir(), 'u2', pins.version, 'u2.jar')
  const cached = await readIfExists(target)
  if (cached && sha256(cached) === pins.jarSha256) return target

  const doFetch = options.fetch ?? fetch
  let wheel: Uint8Array
  try {
    const response = await doFetch(pins.wheelUrl)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    wheel = new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    throw new U2AssetError(
      `cannot download uiautomator2 wheel (${error instanceof Error ? error.message : String(error)}); ` +
        'set CORAL_U2_JAR to a pre-downloaded u2.jar',
    )
  }
  if (sha256(wheel) !== pins.wheelSha256) {
    throw new U2AssetError(`wheel sha256 mismatch: got ${sha256(wheel)}`)
  }
  const jar = unzipSync(wheel, { filter: (file) => file.name === pins.jarEntry })[pins.jarEntry]
  if (!jar) throw new U2AssetError(`${pins.jarEntry} missing from the wheel`)
  if (sha256(jar) !== pins.jarSha256) {
    throw new U2AssetError(`u2.jar sha256 mismatch: got ${sha256(jar)}`)
  }
  await mkdir(dirname(target), { recursive: true })
  // Write then rename so a concurrent reader never sees a partial jar.
  const partial = `${target}.${process.pid}.partial`
  await writeFile(partial, jar)
  await rename(partial, target)
  return target
}
