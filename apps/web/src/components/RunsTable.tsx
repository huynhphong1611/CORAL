import type { api } from '@coral/shared'
import { Link } from '@tanstack/react-router'
import { isActive, useDevices, useRuns, useWatchRuns, type RunFilters } from '../api/queries'
import { en } from '../i18n/en'
import {
  buttonClass,
  elapsed,
  formatTime,
  QueryState,
  shortId,
  StatusBadge,
  Table,
  Td,
  Th,
  useNow,
} from './ui'

/** Runs matching `filters`, newest first; queued and running ones update live. */
export function RunsTable({ filters }: { filters: RunFilters }) {
  const runs = useRuns(filters)
  const devices = useDevices()
  const all = runs.data?.pages.flatMap((page) => page.items) ?? []
  useWatchRuns(all.filter(isActive).map((run) => run.id))
  const deviceName = (id: string) => devices.data?.find((d) => d.id === id)?.model ?? shortId(id)

  return (
    <QueryState query={{ ...runs, data: runs.data ? all : undefined }} empty={en.runs.empty}>
      {(list) => (
        <div className="space-y-3">
          <Table label={en.runs.title}>
            <thead>
              <tr>
                <Th>{en.runs.run}</Th>
                <Th>{en.runs.status}</Th>
                <Th>{en.runs.testCases}</Th>
                <Th>{en.runs.device}</Th>
                <Th>{en.runs.queued}</Th>
                <Th>{en.runs.duration}</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((run) => (
                <RunRow key={run.id} run={run} device={deviceName(run.device_id)} />
              ))}
            </tbody>
          </Table>
          {runs.hasNextPage && (
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={runs.isFetchingNextPage}
              onClick={() => void runs.fetchNextPage()}
            >
              {en.common.loadMore}
            </button>
          )}
        </div>
      )}
    </QueryState>
  )
}

function RunRow({ run, device }: { run: api.Run; device: string }) {
  const slugs = run.items.map((item) => item.slug ?? shortId(item.test_case_id))
  const now = useNow(isActive(run))
  return (
    <tr className="hover:bg-slate-50" data-run-id={run.id}>
      <Td>
        <Link
          to="/runs/$runId"
          params={{ runId: run.id }}
          className={`${buttonClass.link} font-mono`}
        >
          {shortId(run.id)}
        </Link>
      </Td>
      <Td>
        <StatusBadge status={run.status} />
      </Td>
      <Td className="max-w-xs truncate">
        <span title={slugs.join(', ')}>{slugs.join(', ')}</span>
      </Td>
      <Td className="text-slate-600">{device}</Td>
      <Td className="text-slate-500">{formatTime(run.queued_at)}</Td>
      <Td className="text-slate-500">
        {run.started_at ? elapsed(run.started_at, run.finished_at, now) : '—'}
      </Td>
    </tr>
  )
}
