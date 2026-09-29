import { useEffect, useState, type ReactNode } from 'react'
import { ApiError } from '../api/client'
import { en } from '../i18n/en'

const TONES = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  red: 'bg-red-50 text-red-700 ring-red-600/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  blue: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  violet: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  slate: 'bg-slate-100 text-slate-600 ring-slate-500/20',
} as const
export type Tone = keyof typeof TONES

const STATUS_TONES: Record<string, Tone> = {
  passed: 'green',
  failed: 'red',
  error: 'red',
  running: 'blue',
  queued: 'slate',
  pending: 'slate',
  skipped: 'slate',
  cancelled: 'amber',
}

export function Badge({ tone = 'slate', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}
    >
      {children}
    </span>
  )
}

/** Status of a run, run item or step. */
export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONES[status] ?? 'slate'}>
      {status === 'running' && (
        <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
      )}
      {status}
    </Badge>
  )
}

export const buttonClass = {
  primary:
    'inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50',
  secondary:
    'inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50',
  link: 'text-sm font-medium text-slate-900 underline-offset-2 hover:underline',
} as const

export const inputClass =
  'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-slate-200 bg-white ${className}`}>{children}</div>
  )
}

/** Message of a failed call: the server's `message` when it sent one (contracts/web-ui.md). */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  return en.common.error
}

/** Loading, error and empty states of a list; renders `children` when there is data. */
export function QueryState<T>({
  query,
  empty,
  isEmpty = (data) => Array.isArray(data) && data.length === 0,
  children,
}: {
  query: { isPending: boolean; isError: boolean; error: unknown; data: T | undefined }
  empty?: ReactNode
  isEmpty?: (data: T) => boolean
  children: (data: T) => ReactNode
}) {
  if (query.isPending) {
    return (
      <p role="status" className="py-10 text-center text-sm text-slate-500">
        {en.common.loading}
      </p>
    )
  }
  if (query.isError || query.data === undefined) {
    return (
      <p role="alert" className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
        {errorMessage(query.error)}
      </p>
    )
  }
  if (isEmpty(query.data)) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
        {empty ?? en.common.empty}
      </p>
    )
  }
  return <>{children(query.data)}</>
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `2026-09-29 15:04:05` in the viewer's time zone. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** `850 ms`, `12.4 s`, `3 min 5 s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)} min ${s % 60} s`
}

/** Time between two ISO timestamps, or since `from` when `to` is missing. */
export function elapsed(from: string | null, to: string | null, now = Date.now()): string {
  if (!from) return '—'
  return formatDuration(Math.max(0, (to ? Date.parse(to) : now) - Date.parse(from)))
}

export const shortId = (id: string) => id.slice(-8)

/** The current time, ticking every `everyMs` while `active` (a running run's duration). */
export function useNow(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [active, everyMs])
  return now
}

/** Tab strip; the current tab is marked for assistive tech. */
export function Tabs<T extends string>({
  tabs,
  current,
  onSelect,
}: {
  tabs: readonly { id: T; label: string }[]
  current: T
  onSelect: (id: T) => void
}) {
  return (
    <div role="tablist" className="mb-4 flex gap-1 border-b border-slate-200">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === current}
          onClick={() => onSelect(tab.id)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${
            tab.id === current
              ? 'border-slate-900 font-medium text-slate-900'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

export function Table({ children, label }: { children: ReactNode; label: string }) {
  return (
    <Card className="overflow-x-auto">
      <table aria-label={label} className="w-full text-left text-sm">
        {children}
      </table>
    </Card>
  )
}

export function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={`border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-medium tracking-wide text-slate-500 uppercase ${className}`}
    >
      {children}
    </th>
  )
}

export function Td({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <td className={`border-b border-slate-100 px-4 py-2.5 ${className}`}>{children}</td>
}
