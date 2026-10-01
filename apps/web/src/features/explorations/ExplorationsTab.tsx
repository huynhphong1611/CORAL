import { Link } from '@tanstack/react-router'
import { useExplorations } from '../../api/explorations'
import { useRole } from '../../api/queries'
import { Badge, buttonClass, formatTime, QueryState, Table, Td, Th } from '../../components/ui'
import { en } from '../../i18n/en'
import { costOfBudget, EXPLORATION_TONES } from './describe'

const t = en.explorations

/** Starts the Explorer on this project (writers only). */
export function ExploreButton({ projectId }: { projectId: string }) {
  const { canWrite } = useRole()
  if (!canWrite) return null
  return (
    <Link
      to="/projects/$projectId/explore"
      params={{ projectId }}
      search={{}}
      className={buttonClass.secondary}
    >
      {t.explore}
    </Link>
  )
}

/** Explorations of the project, newest first (contracts/web-ui-phase3.md, FR-039). */
export function ExplorationsTab({ projectId }: { projectId: string }) {
  const explorations = useExplorations(projectId)
  return (
    <QueryState query={explorations} empty={t.empty}>
      {(list) => (
        <Table label={en.projects.tabs.explorations}>
          <thead>
            <tr>
              <Th>{t.what}</Th>
              <Th>{t.status}</Th>
              <Th>{t.screens}</Th>
              <Th>{t.tests}</Th>
              <Th>{t.cost}</Th>
              <Th>{t.by}</Th>
              <Th>{t.started}</Th>
              <Th className="w-20" />
            </tr>
          </thead>
          <tbody>
            {list.map((exploration) => (
              <tr key={exploration.id} className="hover:bg-slate-50">
                <Td className="max-w-sm text-slate-700">
                  <div className="text-xs text-slate-500">{exploration.kind}</div>
                  {exploration.goal ?? t.free}
                </Td>
                <Td>
                  <Badge tone={EXPLORATION_TONES[exploration.status]}>{exploration.status}</Badge>
                  {exploration.stop_reason && (
                    <div className="mt-0.5 text-xs text-slate-500">
                      {en.exploration.stopReasons[exploration.stop_reason]}
                    </div>
                  )}
                </Td>
                <Td className="text-slate-600">
                  {exploration.stats.screens} (
                  {en.exploration.newScreens(exploration.stats.new_screens)})
                </Td>
                <Td className="text-slate-600">
                  {exploration.stats.tests_active} / {exploration.stats.tests_written}
                </Td>
                <Td className="text-slate-600">
                  {costOfBudget(exploration.stats.cost_usd, exploration.budget.max_cost_usd)}
                </Td>
                <Td className="text-slate-600">{exploration.created_by.name}</Td>
                <Td className="text-slate-500">
                  {formatTime(exploration.started_at ?? exploration.created_at)}
                </Td>
                <Td>
                  <Link
                    to="/explorations/$explorationId"
                    params={{ explorationId: exploration.id }}
                    search={{ tab: 'progress' }}
                    className={buttonClass.link}
                  >
                    {t.open}
                  </Link>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </QueryState>
  )
}
