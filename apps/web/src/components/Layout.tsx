import { Link, Outlet, useNavigate, useRouteContext } from '@tanstack/react-router'
import { useSyncExternalStore } from 'react'
import { en } from '../i18n/en'

const navItems = [
  { to: '/projects', label: en.nav.projects },
  { to: '/devices', label: en.nav.devices },
  { to: '/runs', label: en.nav.runs },
  { to: '/settings/brains', label: en.nav.brains },
] as const

/** Top bar (brand, Projects · Devices · Runs · AI, user, role, Sign out) around every signed-in page. */
export function Layout() {
  const { client, session } = useRouteContext({ from: '/_app' })
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const navigate = useNavigate()
  const user = snapshot.session?.user
  const role = snapshot.session?.tenant.role

  async function signOut() {
    await client.logout().catch(() => undefined)
    await navigate({ to: '/login', search: { next: undefined } })
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-8 px-6">
          <Link to="/projects" className="flex items-center gap-2 font-semibold tracking-tight">
            <span aria-hidden className="h-3 w-3 rounded-full bg-[#ff7f50]" />
            {en.brand}
          </Link>
          <nav aria-label="Main" className="flex gap-1">
            {navItems.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                activeProps={{ className: 'bg-slate-100 font-medium text-slate-900' }}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            {user && <span className="text-slate-700">{user.name}</span>}
            {role && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                {en.roles[role]}
              </span>
            )}
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-slate-700 hover:bg-slate-100"
            >
              {en.session.signOut}
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  )
}

/** Title row of a page. */
export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-center justify-between">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {children}
    </div>
  )
}
