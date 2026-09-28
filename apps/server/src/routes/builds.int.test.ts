import { createHash, randomBytes } from 'node:crypto'
import { api } from '@coral/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer, type TestUser } from '../testing/test-server'

let server: TestServer
let huynh: TestUser
let appId = ''

function multipart(fields: Record<string, string>, file?: { name: string; data: Buffer }) {
  const boundary = `----coral${randomBytes(8).toString('hex')}`
  const chunks: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    )
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      file.data,
      Buffer.from('\r\n'),
    )
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

beforeAll(async () => {
  server = await startTestServer({ maxBuildBytes: 64 * 1024 })
  huynh = await server.newUser('Huynh')
  const project = api.projectSchema.parse(
    (await server.call(huynh, { method: 'POST', url: '/projects', payload: { name: 'Builds' } }))
      .body,
  )
  appId = api.appSchema.parse(
    (
      await server.call(huynh, {
        method: 'POST',
        url: `/projects/${project.id}/apps`,
        payload: { platform: 'android', package_or_bundle_id: 'com.example.app', name: 'App' },
      })
    ).body,
  ).id
})
afterAll(() => server.close())

describe('builds', () => {
  it('streams the APK to S3 with sha256 and size computed on the way', async () => {
    const data = randomBytes(40 * 1024)
    const res = await server.call(huynh, {
      method: 'POST',
      url: `/apps/${appId}/builds`,
      ...multipart({ version: '1.2.3' }, { name: 'mydemo.apk', data }),
    })
    expect(res.status).toBe(201)
    const build = api.buildSchema.parse(res.body)
    expect(build).toMatchObject({
      app_id: appId,
      version: '1.2.3',
      size_bytes: data.length,
      checksum_sha256: createHash('sha256').update(data).digest('hex'),
    })
    const key = `${huynh.tenantId}/builds/${build.id}.apk`
    const download = await fetch((await server.artifacts.presignGet(key)).url)
    expect(Buffer.from(await download.arrayBuffer())).toEqual(data)

    const list = await server.call(huynh, { method: 'GET', url: `/apps/${appId}/builds` })
    expect((list.body as unknown as { id: string }[]).map((b) => b.id)).toEqual([build.id])
  })

  it('refuses builds over the size limit with 413 and keeps nothing', async () => {
    const res = await server.call(huynh, {
      method: 'POST',
      url: `/apps/${appId}/builds`,
      ...multipart({ version: '9.9.9' }, { name: 'big.apk', data: randomBytes(100 * 1024) }),
    })
    expect(res.status).toBe(413)
    expect(api.apiErrorSchema.parse(res.body).error.code).toBe('payload_too_large')
    const list = await server.call(huynh, { method: 'GET', url: `/apps/${appId}/builds` })
    expect((list.body as unknown as { version: string }[]).map((b) => b.version)).not.toContain(
      '9.9.9',
    )
  })

  it('validates the form', async () => {
    const noVersion = await server.call(huynh, {
      method: 'POST',
      url: `/apps/${appId}/builds`,
      ...multipart({}, { name: 'a.apk', data: randomBytes(10) }),
    })
    expect(noVersion.status).toBe(400)
    const notApk = await server.call(huynh, {
      method: 'POST',
      url: `/apps/${appId}/builds`,
      ...multipart({ version: '1' }, { name: 'a.ipa', data: randomBytes(10) }),
    })
    expect(notApk.status).toBe(400)
    const noFile = await server.call(huynh, {
      method: 'POST',
      url: `/apps/${appId}/builds`,
      ...multipart({ version: '1' }),
    })
    expect(noFile.status).toBe(400)
  })

  it('hides apps of other tenants', async () => {
    const other = await server.newUser('Other')
    const res = await server.call(other, {
      method: 'POST',
      url: `/apps/${appId}/builds`,
      ...multipart({ version: '1' }, { name: 'a.apk', data: randomBytes(10) }),
    })
    expect(res.status).toBe(404)
  })
})
