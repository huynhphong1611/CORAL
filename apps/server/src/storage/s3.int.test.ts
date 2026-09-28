import {
  GetBucketLifecycleConfigurationCommand,
  GetObjectTaggingCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { newId } from '@coral/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../config'
import { runItemResultKey, stepArtifactKey, stepPrefix } from './keys'
import { createArtifactStore, PUT_URL_TTL_SEC, RUN_ARTIFACT_TAG } from './s3'

const { s3 } = loadConfig(process.env)
const store = createArtifactStore(s3)
const admin = new S3Client({
  endpoint: s3.endpoint,
  region: s3.region,
  forcePathStyle: true,
  credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
})
const tenant = newId()

beforeAll(() => store.ensureBucket())

describe('artifact store (MinIO)', () => {
  it('is idempotent and installs the 30-day run-artifact rule', async () => {
    await store.ensureBucket()
    const lifecycle = await admin.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: s3.bucket }),
    )
    expect(lifecycle.Rules?.[0]).toMatchObject({
      Status: 'Enabled',
      Expiration: { Days: 30 },
      Filter: { Tag: { Key: RUN_ARTIFACT_TAG.key, Value: RUN_ARTIFACT_TAG.value } },
    })
  })

  it('uploads through a presigned PUT and reads back through a presigned GET', async () => {
    const key = stepArtifactKey(stepPrefix(tenant, newId(), newId(), 0, 'open'), 'tree.json')
    const put = await store.presignPut(key, 'application/json', { runArtifact: true })
    expect(put.expiresAt.getTime() - Date.now()).toBeGreaterThan((PUT_URL_TTL_SEC - 5) * 1000)

    const body = JSON.stringify([{ ref: 'e1' }])
    const uploaded = await fetch(put.url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(uploaded.status).toBe(200)

    const tags = await admin.send(new GetObjectTaggingCommand({ Bucket: s3.bucket, Key: key }))
    expect(tags.TagSet).toEqual([{ Key: RUN_ARTIFACT_TAG.key, Value: RUN_ARTIFACT_TAG.value }])

    const get = await store.presignGet(key)
    const downloaded = await fetch(get.url)
    expect(downloaded.status).toBe(200)
    expect(await downloaded.text()).toBe(body)
  })

  it('does not tag objects that must be kept', async () => {
    const key = runItemResultKey(tenant, newId(), newId())
    const put = await store.presignPut(key, 'application/json')
    await fetch(put.url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const tags = await admin.send(new GetObjectTaggingCommand({ Bucket: s3.bucket, Key: key }))
    expect(tags.TagSet).toEqual([])
  })

  it('refuses a PUT with a different content type than signed', async () => {
    const key = runItemResultKey(tenant, newId(), newId())
    const put = await store.presignPut(key, 'application/json')
    const res = await fetch(put.url, {
      method: 'PUT',
      headers: { 'content-type': 'text/html' },
      body: 'x',
    })
    expect(res.status).toBe(403)
  })
})
