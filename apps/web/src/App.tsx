import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { useEffect, useSyncExternalStore } from 'react'
import { en } from './i18n/en'
import type { createAppRouter, RouterContext } from './router'

/**
 * Waits for the first refresh (a reload keeps the session), then renders the routes; every later
 * sign in or out re-runs the route guards.
 */
export function App({
  router,
  context,
}: {
  router: ReturnType<typeof createAppRouter>
  context: RouterContext
}) {
  const { session } = context
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)
  useEffect(() => {
    if (snapshot.status !== 'loading') void router.invalidate()
  }, [router, snapshot.status])
  if (snapshot.status === 'loading') {
    return (
      <p role="status" className="p-8 text-sm text-slate-500">
        {en.session.loading}
      </p>
    )
  }
  return (
    <QueryClientProvider client={context.queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}
