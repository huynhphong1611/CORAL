import { useNavigate, useRouteContext, useSearch } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { ApiError } from '../api/client'
import { en } from '../i18n/en'

/** Only same-app paths: `/runs/…`, never `//evil.example` or a full URL. */
export function safeNext(next: string | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/projects'
}

/** Sign in (US1 scenarios 1–2): one generic message, whatever was wrong. */
export function LoginPage() {
  const { client } = useRouteContext({ from: '/login' })
  const { next } = useSearch({ from: '/login' })
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await client.login(email, password)
      await navigate({ href: safeNext(next) })
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 401
          ? en.login.invalid
          : failure instanceof ApiError && failure.status === 429
            ? en.login.tooMany
            : en.login.failed,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <form
        onSubmit={(event) => void submit(event)}
        className="w-full max-w-sm space-y-5 rounded-xl border border-slate-200 bg-white p-8 shadow-sm"
        aria-labelledby="login-title"
      >
        <div className="space-y-1">
          <div className="flex items-center gap-2 font-semibold tracking-tight">
            <span aria-hidden className="h-3 w-3 rounded-full bg-[#ff7f50]" />
            {en.brand}
          </div>
          <h1 id="login-title" className="text-2xl font-semibold tracking-tight">
            {en.login.title}
          </h1>
          <p className="text-sm text-slate-500">{en.login.subtitle}</p>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="font-medium text-slate-700">{en.login.email}</span>
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="font-medium text-slate-700">{en.login.password}</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
          />
        </label>
        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {busy ? en.login.submitting : en.login.submit}
        </button>
      </form>
    </div>
  )
}
