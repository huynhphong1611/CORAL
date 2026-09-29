import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { api } from '@coral/shared'
import type { ApiClient } from './api/client'
import type { SessionStore } from './api/session'
import type { UiSocket } from './api/ws'
import { Layout } from './components/Layout'
import { DevicesPage } from './routes/devices'
import { LoginPage, safeNext } from './routes/login'
import { ProjectsPage } from './routes/projects'
import { PROJECT_TABS, ProjectPage, type ProjectTab } from './routes/projects/project'
import { RunDetailPage } from './routes/runs/detail'
import { RunsPage } from './routes/runs'

export interface RouterContext {
  client: ApiClient
  session: SessionStore
  socket: UiSocket
  queryClient: QueryClient
}

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: () => <Outlet /> })

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>): { next?: string | undefined } => ({
    next: typeof search.next === 'string' ? search.next : undefined,
  }),
  beforeLoad: ({ context, search }) => {
    if (context.session.signedIn) throw redirect({ href: safeNext(search.next) })
  },
  component: LoginPage,
})

/** Every page but /login needs a session; otherwise → /login?next=<where you were going>. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_app',
  beforeLoad: ({ context, location }) => {
    if (!context.session.signedIn) throw redirect({ to: '/login', search: { next: location.href } })
  },
  component: Layout,
})

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/projects' })
  },
})

const projectsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/projects',
  component: ProjectsPage,
})

const projectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/projects/$projectId',
  validateSearch: (search: Record<string, unknown>): { tab: ProjectTab } => ({
    tab: PROJECT_TABS.find((t) => t === search.tab) ?? 'testcases',
  }),
  component: ProjectPage,
})

const devicesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/devices',
  component: DevicesPage,
})

const uuid = (value: unknown) =>
  typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined

const runsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/runs',
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    project_id?: string | undefined
    status?: api.Run['status'] | undefined
    device_id?: string | undefined
  } => ({
    project_id: uuid(search.project_id),
    status: api.RUN_STATUSES.find((s) => s === search.status),
    device_id: uuid(search.device_id),
  }),
  component: RunsPage,
})

const runRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/runs/$runId',
  component: RunDetailPage,
})

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    indexRoute,
    projectsRoute,
    projectRoute,
    devicesRoute,
    runsRoute,
    runRoute,
  ]),
])

/** The app's routes (contracts/web-ui.md); `history` is a memory history in tests. */
export function createAppRouter(context: RouterContext, history?: RouterHistory) {
  return createRouter({ routeTree, context, ...(history ? { history } : {}) })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
