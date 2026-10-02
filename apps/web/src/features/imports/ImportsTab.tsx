import type { api } from '@coral/shared'
import { Link } from '@tanstack/react-router'
import { useImports } from '../../api/imports'
import { useRole } from '../../api/queries'
import {
  Badge,
  buttonClass,
  formatTime,
  QueryState,
  Table,
  Td,
  Th,
  type Tone,
} from '../../components/ui'
import { en } from '../../i18n/en'
import { usd } from '../explorations/describe'

const t = en.imports

export const IMPORT_TONES: Record<api.ImportJobStatus, Tone> = {
  preview: 'slate',
  running: 'blue',
  done: 'green',
  cancelled: 'amber',
  failed: 'red',
}

export const ITEM_TONES: Record<api.ImportItemStatus, Tone> = {
  pending: 'slate',
  running: 'blue',
  active: 'green',
  draft: 'amber',
  not_processed: 'slate',
}

/** Imports of the project, newest first (contracts/web-ui-phase3.md, US6). */
export function ImportsTab({ projectId }: { projectId: string }) {
  const imports = useImports(projectId)
  const { canWrite } = useRole()
  return (
    <div className="space-y-3">
      {canWrite && (
        <div className="flex justify-end">
          <Link
            to="/projects/$projectId/imports/new"
            params={{ projectId }}
            className={buttonClass.secondary}
          >
            {t.newImport}
          </Link>
        </div>
      )}
      <QueryState query={imports} empty={t.empty}>
        {(list) => (
          <Table label={t.table}>
            <thead>
              <tr>
                <Th>{t.file}</Th>
                <Th>{t.status}</Th>
                <Th>{t.progress}</Th>
                <Th>{t.active}</Th>
                <Th>{t.draft}</Th>
                <Th>{t.cost}</Th>
                <Th>{t.created}</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((job) => (
                <tr key={job.id} className="hover:bg-slate-50">
                  <Td>
                    <Link
                      to="/imports/$importId"
                      params={{ importId: job.id }}
                      className={`${buttonClass.link} font-mono`}
                    >
                      {job.file_name}
                    </Link>
                    <div className="text-xs text-slate-500">{job.source_format}</div>
                  </Td>
                  <Td>
                    <Badge tone={IMPORT_TONES[job.status]}>{job.status}</Badge>
                  </Td>
                  <Td className="text-slate-600">
                    {job.stats.done} / {job.stats.total}
                  </Td>
                  <Td className="text-slate-600">{job.stats.active}</Td>
                  <Td className="text-slate-600">{job.stats.draft}</Td>
                  <Td className="text-slate-600">{usd(job.stats.cost_usd)}</Td>
                  <Td className="text-slate-500">{formatTime(job.created_at)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </QueryState>
    </div>
  )
}
