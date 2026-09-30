import { api } from '@coral/shared'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useDevices, useProjects } from '../../api/queries'
import { PageHeader } from '../../components/Layout'
import { RunsTable } from '../../components/RunsTable'
import { inputClass } from '../../components/ui'
import { en } from '../../i18n/en'

/** `/runs`: every run of the tenant, filtered by project, status and device; live (FR-003). */
export function RunsPage() {
  const filters = useSearch({ from: '/_app/runs' })
  const navigate = useNavigate({ from: '/runs' })
  const projects = useProjects()
  const devices = useDevices()
  const set = (name: keyof typeof filters, value: string) =>
    void navigate({ search: (prev) => ({ ...prev, [name]: value || undefined }) })

  return (
    <section>
      <PageHeader title={en.runs.title}>
        <div className="flex gap-2">
          <select
            aria-label={en.runs.project}
            className={inputClass}
            value={filters.project_id ?? ''}
            onChange={(e) => set('project_id', e.target.value)}
          >
            <option value="">{en.runs.anyProject}</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            aria-label={en.runs.status}
            className={inputClass}
            value={filters.status ?? ''}
            onChange={(e) => set('status', e.target.value)}
          >
            <option value="">{en.runs.anyStatus}</option>
            {api.RUN_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          <select
            aria-label={en.runs.device}
            className={inputClass}
            value={filters.device_id ?? ''}
            onChange={(e) => set('device_id', e.target.value)}
          >
            <option value="">{en.runs.anyDevice}</option>
            {devices.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.model} · {d.udid}
              </option>
            ))}
          </select>
        </div>
      </PageHeader>
      <RunsTable filters={filters} />
    </section>
  )
}
