import {
  DEFAULT_PROVIDER_CAPABILITIES,
  validateBrainsSource,
  type api,
  type ProviderCapability,
} from '@coral/shared'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAiUsage, useBrainsConfig, useSaveBrains } from '../../api/brains'
import { ApiError } from '../../api/client'
import { useRole } from '../../api/queries'
import { PageHeader } from '../../components/Layout'
import {
  Badge,
  buttonClass,
  Card,
  errorMessage,
  QueryState,
  Table,
  Tabs,
  Td,
  Th,
} from '../../components/ui'
import { YamlEditor, type EditorIssue, type YamlEditorHandle } from '../../components/YamlEditor'
import { CHECK_MS, useDebounced, type Problem } from '../../features/editor/check'
import { usd } from '../../features/explorations/describe'
import { en } from '../../i18n/en'

const t = en.brains
const SOURCE_TONES = { tenant: 'green', platform: 'blue', none: 'amber' } as const

/**
 * Checks the text in the browser with the shared schema (FR-004), for the providers this server
 * runs; prices are checked by the server on Save (it holds the platform's price table).
 */
export function checkBrains(text: string, providers: api.BrainsConfigView['providers']): Problem[] {
  if (text.trim() === '') return []
  const capabilities: Record<string, ProviderCapability> = Object.fromEntries(
    providers.map((p) => [
      p.id,
      { enabled: p.enabled, vision: p.vision, optIn: DEFAULT_PROVIDER_CAPABILITIES[p.id].optIn },
    ]),
  )
  return validateBrainsSource(text, 'brains.yaml', { providers: capabilities }).errors
}

const toIssue = (problem: Problem): EditorIssue => ({
  severity: 'error',
  message: `${problem.code}: ${problem.message}`,
  line: problem.line,
  column: problem.column,
})

/** `/settings/brains` — the tenant's AI brains and what the AI cost (US1, FR-040, FR-010). */
export function BrainsPage() {
  const config = useBrainsConfig()
  return (
    <section>
      <PageHeader title={t.title} />
      <QueryState query={config} isEmpty={() => false}>
        {/* Not keyed by the YAML: after Save the text already is the saved one. */}
        {(view) => <BrainsEditor view={view} />}
      </QueryState>
      <UsagePanel />
    </section>
  )
}

function BrainsEditor({ view }: { view: api.BrainsConfigView }) {
  const { role } = useRole()
  const canEdit = role === 'owner' || role === 'admin'
  const save = useSaveBrains()
  const editor = useRef<YamlEditorHandle>(null)
  const [text, setText] = useState(view.yaml)
  const [notice, setNotice] = useState<string | undefined>()
  // Problems only the server can find (prices) hold until the text changes.
  const [serverProblems, setServerProblems] = useState<{ text: string; problems: Problem[] }>()

  const settled = useDebounced(text, CHECK_MS)
  const checking = settled !== text
  const checked = useMemo(() => checkBrains(settled, view.providers), [settled, view.providers])
  const fromServer = serverProblems?.text === text ? serverProblems.problems : []
  const errors = [...checked, ...fromServer]
  const dirty = text !== view.yaml
  const canSave =
    canEdit && dirty && text.trim() !== '' && !checking && errors.length === 0 && !save.isPending

  useEffect(() => {
    if (!dirty) return undefined
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  function submit() {
    setNotice(undefined)
    save.mutate(text, {
      onSuccess: () => setNotice(t.saved),
      onError: (error) => {
        if (error instanceof ApiError && Array.isArray(error.details) && error.details.length) {
          setServerProblems({ text, problems: error.details })
        } else {
          setNotice(errorMessage(error))
        }
      },
    })
  }

  return (
    <div className="mb-8 flex flex-col gap-6 lg:flex-row lg:items-start">
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-slate-500">{t.source}</span>
          <span data-testid="brains-source">
            <Badge tone={SOURCE_TONES[view.source]}>{t.sources[view.source]}</Badge>
          </span>
          <span className="text-slate-500">{t.sourceHint[view.source]}</span>
          {canEdit && (
            <button
              type="button"
              className={`${buttonClass.primary} ml-auto`}
              disabled={!canSave}
              onClick={submit}
            >
              {save.isPending ? t.saving : t.save}
            </button>
          )}
        </div>
        {!canEdit && <p className="text-sm text-slate-500">{t.readOnly}</p>}
        {text === '' && canEdit && <p className="text-sm text-slate-500">{t.placeholder}</p>}
        <YamlEditor
          ref={editor}
          value={text}
          onChange={(next) => {
            setText(next)
            setNotice(undefined)
          }}
          issues={checking ? [] : errors.map(toIssue)}
          readOnly={!canEdit}
          label={t.label}
        />
        <div className="space-y-2 text-sm" data-testid="brains-status">
          <p className="text-xs">
            {checking ? (
              <span className="text-slate-500">{en.editor.checking}</span>
            ) : errors.length > 0 ? (
              <span className="font-medium text-red-700">{en.editor.problems(errors.length)}</span>
            ) : (
              <span className="text-emerald-700">{en.editor.valid}</span>
            )}
          </p>
          {!checking && errors.length > 0 && (
            <ul role="alert" aria-label="Errors" className="space-y-0.5 text-xs text-red-700">
              {errors.map((p) => (
                <li key={`${p.path}-${p.code}-${p.line ?? ''}`}>
                  {p.line !== undefined && (
                    <button
                      type="button"
                      className="font-mono underline-offset-2 hover:underline"
                      onClick={() => editor.current?.reveal(p)}
                    >
                      {en.editor.issueAt(p.line, p.column ?? 1)}
                    </button>
                  )}
                  {p.line !== undefined && ' · '}
                  {p.code}: {p.message}
                </li>
              ))}
            </ul>
          )}
          {notice && (
            <p role="status" className="rounded-md bg-slate-100 px-3 py-2 text-slate-700">
              {notice}
            </p>
          )}
        </div>
      </div>
      <Card className="w-full p-4 lg:w-72">
        <h2 className="mb-3 text-sm font-medium">{t.providers}</h2>
        <table aria-label={t.providers} className="w-full text-left text-sm">
          <thead className="text-xs text-slate-500">
            <tr>
              <th className="py-1 font-medium">{t.provider}</th>
              <th className="py-1 font-medium">{t.enabled}</th>
              <th className="py-1 font-medium">{t.vision}</th>
            </tr>
          </thead>
          <tbody>
            {view.providers.map((p) => (
              <tr key={p.id} className="border-t border-slate-100">
                <td className="py-1.5 font-mono">{p.id}</td>
                <td className="py-1.5">
                  <Badge tone={p.enabled ? 'green' : 'slate'}>{p.enabled ? t.yes : t.no}</Badge>
                </td>
                <td className="py-1.5 text-slate-600">{p.vision ? t.yes : t.no}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}

const GROUPS = ['day', 'role', 'provider'] as const

function UsagePanel() {
  const [group, setGroup] = useState<api.UsageQuery['group']>('day')
  const usage = useAiUsage(group)
  return (
    <div>
      <h2 className="mb-2 text-base font-semibold">{t.usage}</h2>
      <Tabs
        tabs={GROUPS.map((id) => ({ id, label: t.groups[id] }))}
        current={group}
        onSelect={setGroup}
      />
      <QueryState query={usage} isEmpty={() => false}>
        {(data) => (
          <div className="space-y-3">
            <p className="text-sm" data-testid="usage-today">
              <span className="text-slate-500">{t.today}: </span>
              {data.today.limit_usd === null
                ? `${usd(data.today.cost_usd)} — ${t.noLimit}`
                : t.todayOf(usd(data.today.cost_usd), usd(data.today.limit_usd))}
            </p>
            {data.rows.length === 0 ? (
              <p className="text-sm text-slate-500">{t.noUsage}</p>
            ) : (
              <Table label={t.usage}>
                <thead>
                  <tr>
                    <Th>{t.key[group]}</Th>
                    <Th className="text-right">{t.calls}</Th>
                    <Th className="text-right">{t.tokensIn}</Th>
                    <Th className="text-right">{t.tokensOut}</Th>
                    <Th className="text-right">{t.cost}</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.key}>
                      <Td className="font-mono">{row.key}</Td>
                      <Td className="text-right">{row.calls}</Td>
                      <Td className="text-right">{row.tokens_in.toLocaleString('en')}</Td>
                      <Td className="text-right">{row.tokens_out.toLocaleString('en')}</Td>
                      <Td className="text-right">{usd(row.cost_usd)}</Td>
                    </tr>
                  ))}
                  <tr>
                    <Td className="font-medium">{t.total}</Td>
                    <Td />
                    <Td />
                    <Td />
                    <Td className="text-right font-medium">{usd(data.total_cost_usd)}</Td>
                  </tr>
                </tbody>
              </Table>
            )}
          </div>
        )}
      </QueryState>
    </div>
  )
}
