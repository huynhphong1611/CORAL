import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

/**
 * The local path of a build (`<cacheDir>/builds/<sha256>.apk`): downloaded once per sha256 and
 * checked against it — for jobs and for a recording's `prepare`.
 */
export async function cachedBuild(
  build: { download_url: string; sha256: string },
  cacheDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const dir = join(cacheDir, 'builds')
  const path = join(dir, `${build.sha256}.apk`)
  const cached = await readFile(path).catch(() => undefined)
  if (cached && sha256(cached) === build.sha256) return path
  const res = await fetchImpl(build.download_url)
  if (!res.ok) throw new Error(`build download failed: HTTP ${res.status}`)
  const data = new Uint8Array(await res.arrayBuffer())
  if (sha256(data) !== build.sha256) throw new Error('build checksum mismatch')
  await mkdir(dir, { recursive: true })
  const partial = `${path}.${process.pid}.partial`
  await writeFile(partial, data)
  await rename(partial, path)
  return path
}
