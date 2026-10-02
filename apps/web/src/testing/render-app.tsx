import { newId } from '@coral/shared'
import { QueryClient } from '@tanstack/react-query'
import { createMemoryHistory } from '@tanstack/react-router'
import { act, render } from '@testing-library/react'
import { vi } from 'vitest'
import { ApiClient } from '../api/client'
import { SessionStore } from '../api/session'
import { UiSocket } from '../api/ws'
import { App } from '../App'
import { createAppRouter } from '../router'
import { FakeSocket } from './fake-socket'

export const TEST_USER = { id: newId(), email: 'huynh@coral.test', name: 'Huynh' }

export const session = (role = 'owner') => ({
  access_token: 'token',
  expires_in: 900,
  user: TEST_USER,
  tenant: { id: newId(), name: 'coral', role },
})

export interface FakeRequest {
  method: string
  url: URL
  body: unknown
  contentType?: string | undefined
}

/** A canned answer: a Response, a JSON body, or a function of the request returning either. */
export type FakeHandler = (request: FakeRequest) => Response | object | Promise<Response | object>
export type FakeAnswer = Response | object | FakeHandler

export interface RenderOptions {
  signedIn?: boolean
  role?: string
  /** Keyed `METHOD /path` (API paths without `/api` and without the query) or `GET <full URL>`. */
  routes?: Record<string, FakeAnswer>
}

const notFound = (key: string) =>
  Response.json({ error: { code: 'not_found', message: `${key} not found` } }, { status: 404 })

/**
 * The whole app on a fake server (fetch) and a fake `/ws/ui` (the test plays the server), signed
 * in unless `signedIn: false`. Every request is recorded in `requests`.
 */
export async function renderApp(path: string, options: RenderOptions = {}) {
  const { signedIn = true, role = 'owner', routes = {} } = options
  const requests: FakeRequest[] = []
  const fetchImpl = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(href, 'http://coral.test')
    const method = init.method ?? 'GET'
    const headers = new Headers(init.headers)
    // JSON bodies parsed; other text (a YAML file) kept as sent.
    const body: unknown =
      typeof init.body !== 'string'
        ? undefined
        : headers.get('content-type')?.includes('json')
          ? JSON.parse(init.body)
          : init.body
    const request = { method, url, body, contentType: headers.get('content-type') ?? undefined }
    requests.push(request)
    const apiPath = url.origin === 'http://coral.test' ? url.pathname.replace(/^\/api/, '') : ''
    const key = apiPath ? `${method} ${apiPath}` : `${method} ${url.href}`
    if (key === 'POST /auth/refresh') {
      return Promise.resolve(
        signedIn
          ? Response.json(session(role))
          : Response.json({ error: { code: 'unauthorized', message: 'no' } }, { status: 401 }),
      )
    }
    if (key === 'POST /auth/logout') return Promise.resolve(new Response(null, { status: 204 }))
    const answer = routes[key]
    if (answer === undefined) return Promise.resolve(notFound(key))
    const value = typeof answer === 'function' ? (answer as FakeHandler)(request) : answer
    return Promise.resolve(value).then((v) => (v instanceof Response ? v : Response.json(v)))
  }) as typeof fetch
  // Artifacts (logs, trees) are fetched with the global fetch.
  vi.stubGlobal('fetch', fetchImpl)
  // jsdom has no scrolling; the router restores scroll on navigation.
  vi.stubGlobal('scrollTo', () => undefined)

  const store = new SessionStore()
  const client = new ApiClient({ fetch: fetchImpl, onSession: (s) => store.set(s) })
  const socket = new UiSocket({
    url: 'ws://coral.test/api/ws/ui',
    token: () => client.accessToken,
    create: (url) => new FakeSocket(url),
  })
  store.subscribe(() => {
    if (store.signedIn) socket.renew()
    else socket.close()
  })
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const context = { client, session: store, socket, queryClient }
  const router = createAppRouter(context, createMemoryHistory({ initialEntries: [path] }))
  render(<App router={router} context={context} />)
  await act(() => client.refresh())
  const server = FakeSocket.all.at(-1)
  if (server) {
    act(() => {
      server.open()
      server.ready()
    })
  }
  return { router, requests, client, socket, server, queryClient }
}

/** Requests to the API as `METHOD /path?query`, in order. */
export const calls = (requests: readonly FakeRequest[]) =>
  requests.map((r) => `${r.method} ${r.url.pathname.replace(/^\/api/, '')}${r.url.search}`)

export function resetFakes() {
  FakeSocket.all = []
  vi.unstubAllGlobals()
}
