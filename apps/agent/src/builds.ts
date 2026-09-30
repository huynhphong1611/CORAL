import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

interface Download {
  download_url: string
  sha256: string
}

/** `<cacheDir>/<dir>/<sha256><ext>`: downloaded once per sha256 and checked against it. */
async function cached(
  what: string,
  item: Download,
  dir: string,
  ext: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const path = join(dir, `${item.sha256}${ext}`)
  const kept = await readFile(path).catch(() => undefined)
  if (kept && sha256(kept) === item.sha256) return path
  const res = await fetchImpl(item.download_url)
  if (!res.ok) throw new Error(`${what} download failed: HTTP ${res.status}`)
  const data = new Uint8Array(await res.arrayBuffer())
  if (sha256(data) !== item.sha256) throw new Error(`${what} checksum mismatch`)
  await mkdir(dir, { recursive: true })
  // One partial file per download: two downloads of the same sha256 must not share it.
  const partial = `${path}.${process.pid}.${randomUUID()}.partial`
  await writeFile(partial, data)
  await rename(partial, path)
  return path
}

/**
 * The local path of a build (`<cacheDir>/builds/<sha256>.apk`): downloaded once per sha256 and
 * checked against it — for jobs and for a recording's `prepare`.
 */
export function cachedBuild(
  build: Download,
  cacheDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  return cached('build', build, join(cacheDir, 'builds'), '.apk', fetchImpl)
}

/** The local path of an `image` locator's reference (`<cacheDir>/assets/<sha256>`, R12). */
export function cachedAsset(
  asset: Download,
  cacheDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  return cached('asset', asset, join(cacheDir, 'assets'), '', fetchImpl)
}
