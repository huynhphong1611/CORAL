import type { api } from '@coral/shared'
import type { FastifyError, FastifyInstance } from 'fastify'
import type { z } from 'zod'

type ErrorDetail = NonNullable<api.ApiError['error']['details']>[number]

/** An error that maps to one HTTP response `{ error: { code, message, details } }`. */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 503,
    readonly code: string,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** Unknown ids and resources of another tenant are both "not found" (never 403 — no probing). */
export function notFound(what: string): HttpError {
  return new HttpError(404, 'not_found', `${what} not found`)
}

/** `["steps", 3, "target"]` → `steps[3].target` */
export function formatPath(path: readonly PropertyKey[]): string {
  return path
    .map((part, i) =>
      typeof part === 'number' ? `[${part}]` : `${i === 0 ? '' : '.'}${String(part)}`,
    )
    .join('')
}

/** Validates request input with a shared Zod schema; throws 400 `validation_failed`. */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  throw new HttpError(
    400,
    'validation_failed',
    'request is invalid',
    result.error.issues.map((issue) => ({
      path: formatPath(issue.path),
      code: issue.code,
      message: issue.message,
    })),
  )
}

function isFastifyError(error: unknown): error is FastifyError {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof (error as FastifyError).statusCode === 'number'
  )
}

/** Installs the single error format of contracts/rest-api.md on a Fastify app. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: { code: 'not_found', message: `${request.method} ${request.url} not found` },
    }),
  )

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      })
    }
    if (isFastifyError(error) && error.statusCode && error.statusCode < 500) {
      const code =
        error.statusCode === 413
          ? 'payload_too_large'
          : error.statusCode === 415
            ? 'unsupported_media_type'
            : 'bad_request'
      return reply.status(error.statusCode).send({ error: { code, message: error.message } })
    }
    request.log.error({ err: error }, 'unhandled error')
    return reply
      .status(500)
      .send({ error: { code: 'internal_error', message: 'internal server error' } })
  })
}
