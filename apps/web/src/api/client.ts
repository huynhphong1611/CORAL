import { api } from '@coral/shared'
import type { z } from 'zod'

/** Base path of coral-server as seen from the browser (Vite proxy / reverse proxy). */
export const API_BASE = '/api'

/** A failed API call with the server's error body (contracts/rest-api.md). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: api.ApiError['error']['details'] = undefined,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

type Session = api.Session

export interface ApiClientOptions {
  base?: string
  fetch?: typeof fetch
  /** The session changed: signed in, refreshed, or gone (null). */
  onSession?: (session: Session | null) => void
}

interface RequestOptions<T> {
  body?: unknown
  form?: FormData
  schema?: z.ZodType<T>
  /** Do not try a refresh on 401 (the auth routes themselves). */
  noRefresh?: boolean
}

/**
 * REST client of the SPA (research R2): the access token lives in memory only, the refresh token
 * in an httpOnly cookie; a 401 triggers one refresh (shared by concurrent calls) and one retry.
 */
export class ApiClient {
  private current: Session | null = null
  private refreshing: Promise<Session | null> | undefined
  private readonly base: string
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: ApiClientOptions = {}) {
    this.base = options.base ?? API_BASE
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args))
  }

  get session(): Session | null {
    return this.current
  }

  get accessToken(): string | undefined {
    return this.current?.access_token
  }

  private setSession(session: Session | null): void {
    this.current = session
    this.options.onSession?.(session)
  }

  async login(email: string, password: string): Promise<Session> {
    const session = await this.request('POST', '/auth/login', {
      body: { email, password },
      schema: api.sessionSchema,
      noRefresh: true,
    })
    this.setSession(session)
    return session
  }

  /** Exchanges the refresh cookie for a new session; null when there is none (signed out). */
  refresh(): Promise<Session | null> {
    this.refreshing ??= this.request('POST', '/auth/refresh', {
      body: {},
      schema: api.sessionSchema,
      noRefresh: true,
    })
      .then((session) => {
        this.setSession(session)
        return session
      })
      .catch(() => {
        this.setSession(null)
        return null
      })
      .finally(() => {
        this.refreshing = undefined
      })
    return this.refreshing
  }

  async logout(): Promise<void> {
    try {
      await this.request('POST', '/auth/logout', { body: {}, noRefresh: true })
    } finally {
      this.setSession(null)
    }
  }

  get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return this.request('GET', path, { schema })
  }

  post<T>(path: string, body: unknown, schema?: z.ZodType<T>): Promise<T> {
    return this.request('POST', path, { body, ...(schema ? { schema } : {}) })
  }

  put<T>(path: string, body: unknown, schema?: z.ZodType<T>): Promise<T> {
    return this.request('PUT', path, { body, ...(schema ? { schema } : {}) })
  }

  patch<T>(path: string, body: unknown, schema?: z.ZodType<T>): Promise<T> {
    return this.request('PATCH', path, { body, ...(schema ? { schema } : {}) })
  }

  delete(path: string): Promise<void> {
    return this.request('DELETE', path, {})
  }

  upload<T>(path: string, form: FormData, schema?: z.ZodType<T>): Promise<T> {
    return this.request('POST', path, { form, ...(schema ? { schema } : {}) })
  }

  /** Bytes of a GET behind the access token (snapshot images of a test case). */
  async blob(path: string): Promise<Blob> {
    return (await this.fetchOk('GET', path, {})).blob()
  }

  async request<T>(method: string, path: string, options: RequestOptions<T>): Promise<T> {
    const response = await this.fetchOk(method, path, options)
    if (response.status === 204) return undefined as T
    const json: unknown = await response.json()
    return options.schema ? options.schema.parse(json) : (json as T)
  }

  /** The response of a call, refreshed and retried once on 401; an ApiError when not ok. */
  private async fetchOk(
    method: string,
    path: string,
    options: RequestOptions<unknown>,
  ): Promise<Response> {
    let response = await this.send(method, path, options)
    if (response.status === 401 && !options.noRefresh) {
      const session = await this.refresh()
      if (session) response = await this.send(method, path, options)
    }
    if (!response.ok) throw await toError(response)
    return response
  }

  private send(method: string, path: string, options: RequestOptions<unknown>): Promise<Response> {
    const headers: Record<string, string> = {}
    if (this.current) headers.authorization = `Bearer ${this.current.access_token}`
    let body: BodyInit | undefined
    if (options.form) {
      body = options.form
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(options.body)
    }
    return this.fetchImpl(`${this.base}${path}`, {
      method,
      headers,
      credentials: 'include',
      ...(body !== undefined ? { body } : {}),
    })
  }
}

async function toError(response: Response): Promise<ApiError> {
  const text = await response.text()
  try {
    const parsed = api.apiErrorSchema.safeParse(JSON.parse(text))
    if (parsed.success) {
      const { code, message, details } = parsed.data.error
      return new ApiError(response.status, code, message, details)
    }
  } catch {
    // Not JSON: fall through.
  }
  return new ApiError(response.status, 'http_error', `HTTP ${response.status}`)
}
