import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router'
import type { ApiClient } from './api/client'
import type { SessionStore } from './api/session'
import type { UiSocket } from './api/ws'
import { Layout } from './components/Layout'
import { en } from './i18n/en'
import { LoginPage, safeNext } from './routes/login'
import { Placeholder } from './routes/placeholder'

export interface RouterContext {
  client: ApiClient
  session: SessionStore
  socket: UiSocket
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
  component: () => <Placeholder title={en.nav.projects} />,
})

const devicesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/devices',
  component: () => <Placeholder title={en.nav.devices} />,
})

const runsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/runs',
  component: () => <Placeholder title={en.nav.runs} />,
})

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([indexRoute, projectsRoute, devicesRoute, runsRoute]),
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
