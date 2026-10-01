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
import { TestCasePage } from './features/editor/TestCasePage'
import {
  EXPLORATION_TABS,
  ExplorationPage,
  type ExplorationTab,
} from './features/explorations/ExplorationPage'
import { StartExplorationPage } from './features/explorations/StartExplorationPage'
import { RecorderPage } from './features/recorder/RecorderPage'
import { StartRecordingPage } from './features/recorder/StartRecordingPage'
import { DevicePage } from './routes/device'
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

const uuid = (value: unknown) =>
  typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined

const testCaseRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/projects/$projectId/testcases/$testCaseId',
  component: TestCasePage,
})

const recordRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/projects/$projectId/record',
  validateSearch: (
    search: Record<string, unknown>,
  ): { app?: string | undefined; build?: string | undefined; device?: string | undefined } => ({
    app: uuid(search.app),
    build: uuid(search.build),
    device: uuid(search.device),
  }),
  component: StartRecordingPage,
})

const exploreRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/projects/$projectId/explore',
  validateSearch: (
    search: Record<string, unknown>,
  ): { app?: string | undefined; build?: string | undefined; device?: string | undefined } => ({
    app: uuid(search.app),
    build: uuid(search.build),
    device: uuid(search.device),
  }),
  component: StartExplorationPage,
})

const explorationRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/explorations/$explorationId',
  validateSearch: (search: Record<string, unknown>): { tab: ExplorationTab } => ({
    tab: EXPLORATION_TABS.find((t) => t === search.tab) ?? 'progress',
  }),
  component: ExplorationPage,
})

const recordingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/recordings/$recordingId',
  component: RecorderPage,
})

const devicesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/devices',
  component: DevicesPage,
})

const deviceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/devices/$deviceId',
  component: DevicePage,
})

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
    testCaseRoute,
    recordRoute,
    recordingRoute,
    exploreRoute,
    explorationRoute,
    devicesRoute,
    deviceRoute,
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
