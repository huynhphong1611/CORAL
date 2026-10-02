import type { api } from '@coral/shared'
import { forEachDiagnostic } from '@codemirror/lint'
import { EditorView } from '@codemirror/view'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderApp, resetFakes, type FakeRequest } from '../../testing/render-app'

// US1 (T024): the AI brains page — the YAML checked as you type with the line of each problem,
// Save locked while it is broken and sent as written, server problems shown, members read only,
// and the usage by day, role or provider against today's limit.

afterEach(() => {
  cleanup()
  resetFakes()
  vi.restoreAllMocks()
})

beforeEach(() => {
  // jsdom has no layout: CodeMirror measures ranges.
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null })
  Range.prototype.getBoundingClientRect = () => new DOMRect()
})

const providers: api.BrainsConfigView['providers'] = [
  { id: 'claude', enabled: true, vision: true },
  { id: 'gemini', enabled: true, vision: true },
  { id: 'copilot', enabled: false, vision: true },
]

const GOOD = `schema: coral/brains@1
# comments stay
roles:
  explorer: { provider: claude, model: some-model }
`

const usage = (group: string): api.Usage => ({
  rows:
    group === 'provider'
      ? [{ key: 'claude', calls: 3, tokens_in: 12000, tokens_out: 300, cost_usd: 0.42 }]
      : [{ key: '2026-10-01', calls: 3, tokens_in: 12000, tokens_out: 300, cost_usd: 0.42 }],
  total_cost_usd: 0.42,
  today: { cost_usd: 0.42, limit_usd: 20 },
})

async function open(
  opts: {
    role?: string
    view?: Partial<api.BrainsConfigView>
    put?: (r: FakeRequest) => Response
  } = {},
) {
  const state: { view: api.BrainsConfigView } = {
    view: { source: 'none', yaml: '', config: null, providers, ...opts.view },
  }
  const app = await renderApp('/settings/brains', {
    ...(opts.role ? { role: opts.role } : {}),
    routes: {
      'GET /brains/config': () => state.view,
      'PUT /brains/config': (request) => {
        const answer = opts.put?.(request)
        if (answer) return answer
        state.view = { ...state.view, source: 'tenant', yaml: String(request.body) }
        return state.view
      },
      'GET /usage/ai': (request) => usage(request.url.searchParams.get('group') ?? 'day'),
    },
  })
  expect(await screen.findByRole('heading', { name: 'AI brains' })).toBeDefined()
  await screen.findByTestId('yaml-editor')
  return app
}

const view = () => {
  const found = EditorView.findFromDOM(screen.getByTestId('yaml-editor'))
  if (!found) throw new Error('no editor')
  return found
}
const edit = (text: string) =>
  act(() => view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: text } }))
const errorLines = () => {
  const lines: number[] = []
  forEachDiagnostic(view().state, (d, from) => {
    if (d.severity === 'error') lines.push(view().state.doc.lineAt(from).number)
  })
  return lines
}
const saveButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Save' })

describe('AI brains page (T024)', () => {
  it('checks the YAML as you type, locks Save while broken, saves it as written', async () => {
    const { requests } = await open()
    expect(screen.getByTestId('brains-source').textContent).toBe('Not configured')
    expect(saveButton().disabled).toBe(true)

    // Line 4 names a provider this server does not run.
    edit(GOOD.replace('provider: claude', 'provider: openai'))
    await waitFor(() => expect(errorLines()).toEqual([4]))
    expect(screen.getByRole('alert').textContent).toContain('Line 4')
    expect(saveButton().disabled).toBe(true)

    edit(GOOD)
    await waitFor(() => expect(screen.getByTestId('brains-status').textContent).toContain('Valid'))
    expect(saveButton().disabled).toBe(false)
    await userEvent.click(saveButton())

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Saved'))
    const put = requests.find((r) => r.method === 'PUT')
    expect(put?.body).toBe(GOOD)
    expect(put?.contentType).toBe('application/yaml')
    expect(screen.getByTestId('brains-source').textContent).toBe('This tenant')
  })

  it('shows what only the server finds (a missing price) at its line, until the text changes', async () => {
    await open({
      put: () =>
        Response.json(
          {
            error: {
              code: 'validation_failed',
              message: 'brains config is not valid',
              details: [
                {
                  path: 'roles.explorer.model',
                  code: 'price_missing',
                  message: 'no price for model "some-model"',
                  line: 4,
                  column: 3,
                },
              ],
            },
          },
          { status: 400 },
        ),
    })
    edit(GOOD)
    await waitFor(() => expect(saveButton().disabled).toBe(false))
    await userEvent.click(saveButton())
    await waitFor(() => expect(errorLines()).toEqual([4]))
    expect(screen.getByRole('alert').textContent).toContain('price_missing')
    expect(saveButton().disabled).toBe(true)
    edit(`${GOOD}prices:\n  some-model: { input: 1, output: 2 }\n`)
    await waitFor(() => expect(saveButton().disabled).toBe(false))
  })

  it('is read only for a member, with the platform default shown', async () => {
    await open({
      role: 'member',
      view: { source: 'platform', yaml: GOOD, config: null },
    })
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.getByText(/only an owner or admin/)).toBeDefined()
    expect(screen.getByTestId('brains-source').textContent).toBe('Platform default')
    expect(view().state.readOnly).toBe(true)
    // The providers this server runs.
    const table = screen.getByRole('table', { name: 'Providers on this server' })
    expect(
      within(table)
        .getAllByRole('row')
        .map((r) => r.textContent),
    ).toEqual(['ProviderEnabledSees images', 'claudeyesyes', 'geminiyesyes', 'copilotnoyes'])
  })

  it('shows the usage by day, role or provider against the daily limit', async () => {
    const { requests } = await open()
    expect((await screen.findByTestId('usage-today')).textContent).toBe(
      'Today: $0.42 of $20.00 daily limit',
    )
    const table = screen.getByRole('table', { name: 'Usage' })
    expect(within(table).getAllByRole('row')[1]?.textContent).toBe('2026-10-01312,000300$0.42')
    await userEvent.click(screen.getByRole('tab', { name: 'By provider' }))
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Usage' })).getAllByRole('row')[1]?.textContent,
      ).toBe('claude312,000300$0.42'),
    )
    expect(requests.some((r) => r.url.search === '?group=provider')).toBe(true)
  })
})
