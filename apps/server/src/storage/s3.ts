import type { Readable } from 'node:stream'
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { ServerConfig } from '../config'

export const PUT_URL_TTL_SEC = 10 * 60
export const GET_URL_TTL_SEC = 15 * 60
export const RUN_ARTIFACT_RETENTION_DAYS = 30

/**
 * Lifecycle filters only match literal prefixes, not a per-tenant `runs/` folder, so run
 * artifacts carry this object tag (set through the presigned PUT) and the rule expires them.
 */
export const RUN_ARTIFACT_TAG = { key: 'coral-retention', value: 'run-artifact' } as const

export interface PresignedUrl {
  url: string
  expiresAt: Date
}

export interface ArtifactStore {
  ensureBucket(): Promise<void>
  presignPut(
    key: string,
    contentType: string,
    opts?: { runArtifact?: boolean },
  ): Promise<PresignedUrl>
  presignGet(key: string): Promise<PresignedUrl>
  /** Streams an object of unknown length (multipart upload); aborts when the stream fails. */
  putStream(key: string, body: Readable, contentType: string): Promise<void>
  /** Stores small bytes (image assets) in one request. */
  putBytes(key: string, body: Uint8Array, contentType: string): Promise<void>
  /** The object's bytes, or undefined when it does not exist. */
  getBytes(key: string): Promise<Uint8Array | undefined>
  /** Size in bytes, or undefined when the object does not exist. */
  size(key: string): Promise<number | undefined>
  remove(key: string): Promise<void>
  /** Deletes every object under `prefix` (a recording's snapshots); returns how many. */
  removePrefix(prefix: string): Promise<number>
  /** The bucket answers (readiness). */
  ready(): Promise<boolean>
}

/** S3-compatible storage (MinIO in dev, R11). Only standard S3 API calls. */
export function createArtifactStore(config: ServerConfig['s3']): ArtifactStore {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  })
  const Bucket = config.bucket
  const expiry = (ttlSec: number) => new Date(Date.now() + ttlSec * 1000)

  return {
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket }))
      } catch {
        try {
          await client.send(new CreateBucketCommand({ Bucket }))
        } catch (error) {
          // Another server instance (or test process) created it in the meantime.
          const name = (error as { name?: string }).name
          if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error
        }
      }
      await client.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket,
          LifecycleConfiguration: {
            Rules: [
              {
                ID: 'expire-run-artifacts',
                Status: 'Enabled',
                Filter: { Tag: { Key: RUN_ARTIFACT_TAG.key, Value: RUN_ARTIFACT_TAG.value } },
                Expiration: { Days: RUN_ARTIFACT_RETENTION_DAYS },
              },
            ],
          },
        }),
      )
    },

    async presignPut(key, contentType, opts = {}) {
      const command = new PutObjectCommand({
        Bucket,
        Key: key,
        ContentType: contentType,
        ...(opts.runArtifact
          ? { Tagging: `${RUN_ARTIFACT_TAG.key}=${RUN_ARTIFACT_TAG.value}` }
          : {}),
      })
      // Signed into the query string, so the uploader only sends Content-Type.
      const url = await getSignedUrl(client, command, {
        expiresIn: PUT_URL_TTL_SEC,
        signableHeaders: new Set(['content-type']),
      })
      return { url, expiresAt: expiry(PUT_URL_TTL_SEC) }
    },

    async putStream(key, body, contentType) {
      await new Upload({
        client,
        params: { Bucket, Key: key, Body: body, ContentType: contentType },
        leavePartsOnError: false,
      }).done()
    },

    async putBytes(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }),
      )
    },

    async getBytes(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket, Key: key }))
        return res.Body ? await res.Body.transformToByteArray() : undefined
      } catch (error) {
        if ((error as { name?: string }).name === 'NoSuchKey') return undefined
        throw error
      }
    },

    async size(key) {
      try {
        return (await client.send(new HeadObjectCommand({ Bucket, Key: key }))).ContentLength
      } catch {
        return undefined
      }
    },

    async ready() {
      try {
        await client.send(new HeadBucketCommand({ Bucket }))
        return true
      } catch {
        return false
      }
    },

    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }))
    },

    async removePrefix(prefix) {
      let removed = 0
      let token: string | undefined
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }),
        )
        const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []))
        if (keys.length > 0) {
          await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys } }))
          removed += keys.length
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined
      } while (token)
      return removed
    },

    async presignGet(key) {
      const url = await getSignedUrl(client, new GetObjectCommand({ Bucket, Key: key }), {
        expiresIn: GET_URL_TTL_SEC,
      })
      return { url, expiresAt: expiry(GET_URL_TTL_SEC) }
    },
  }
}
