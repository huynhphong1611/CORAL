import { api, newId } from '@coral/shared'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as data from '../../testing/data'
import { renderApp, resetFakes, TEST_USER } from '../../testing/render-app'

// US3 (T042): what the AI wrote, in the exploration's Test cases tab and in the editor — where it
// came from, why it is a draft, its flags and validation runs, Activate / Quarantine.
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

const at = '2026-10-01T10:00:00.000Z'
const shop = data.project('Shop')
const explorationId = newId()
const runs = [newId(), newId()]

const YAML = `schema: coral/testcase@1
id: open-cart
intent: Open the cart
platforms: [android]
preconditions: { app_state: fresh }
steps:
  - id: s1
    action: launch
  - id: s2
    action: tap
    target: [{ android_id: id/cartIV }]
    expect: { visible_text: 'My Cart' }
`

const written = (slug: string, over: Partial<api.TestCaseSummary> = {}) =>
  data.testCase(slug, {
    status: 'draft',
    source: 'ai_explore',
    source_ref: `exploration:${explorationId}`,
    ...over,
  })

/** The editor of `summary` on a fake server; PATCH /testcases/:id answers with the new status. */
async function openEditor(summary: api.TestCaseSummary, role?: string) {
  const state = { summary }
  const app = await renderApp(`/projects/${shop.id}/testcases/${summary.id}`, {
    ...(role ? { role } : {}),
    routes: {
      'GET /projects': [shop],
      [`GET /projects/${shop.id}/testcases`]: () => [state.summary],
      [`GET /testcases/${summary.id}`]: () => ({ ...state.summary, yaml: YAML }),
      [`GET /testcases/${summary.id}/snapshots`]: [],
      [`GET /testcases/${summary.id}/last-run-steps`]: [],
      [`PATCH /testcases/${summary.id}`]: (request) => {
        const { status } = api.patchTestCaseSchema.parse(request.body)
        state.summary = {
          ...state.summary,
          status,
          draft_reason: status === 'draft' ? state.summary.draft_reason : null,
          flags: status === 'active' ? [] : state.summary.flags,
        }
        return state.summary
      },
    },
  })
  expect(await screen.findByRole('heading', { name: summary.slug })).toBeDefined()
  return { ...app, panel: await screen.findByTestId('testcase-status') }
}

const patches = (requests: { method: string; body: unknown }[]) =>
  requests.filter((r) => r.method === 'PATCH').map((r) => r.body)

describe('test cases the AI wrote (T042)', () => {
  it('shows where a test case came from, why it is a draft and its validation runs', async () => {
    const summary = written('open-cart', {
      draft_reason: 'validation_failed',
      validation: {
        commit: 'a'.repeat(40),
        runs: [
          { run_id: runs[0] ?? '', status: 'passed' },
          { run_id: runs[1] ?? '', status: 'failed', failure_code: 'EXPECT_FAILED', step_id: 's2' },
        ],
      },
    })
    const { panel, requests } = await openEditor(summary)

    expect(within(panel).getByText('AI exploration')).toBeDefined()
    const link = within(panel).getByRole<HTMLAnchorElement>('link', {
      name: `Exploration ${explorationId.slice(-8)}`,
    })
    expect(link.getAttribute('href')).toBe(`/explorations/${explorationId}?tab=testcases`)
    expect(within(panel).getByTestId('draft-reason').textContent).toContain(
      'a validation run failed',
    )
    const validation = within(panel).getByTestId('validation-runs')
    expect(validation.textContent).toContain('Run 1passed')
    expect(validation.textContent).toContain('Run 2failed · at s2 · EXPECT_FAILED')
    expect(
      within(validation)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(runs.map((id) => `/runs/${id}`))

    // A person decides it is fine after all.
    await userEvent.click(within(panel).getByRole('button', { name: 'Activate' }))
    await waitFor(() =>
      expect(within(panel).queryByRole('button', { name: 'Activate' })).toBeNull(),
    )
    expect(patches(requests)).toEqual([{ status: 'active' }])
    expect(within(panel).getByText('active')).toBeDefined()
    expect(within(panel).queryByTestId('draft-reason')).toBeNull()

    await userEvent.click(within(panel).getByRole('button', { name: 'Quarantine' }))
    await waitFor(() => expect(within(panel).getByText('quarantined')).toBeDefined())
    expect(patches(requests)).toEqual([{ status: 'active' }, { status: 'quarantined' }])
  })

  it('lets only an owner or admin activate a test case that taps a never_tap element', async () => {
    const summary = written('place-order', { flags: ['needs_review_never_tap'] })
    const member = await openEditor(summary, 'member')
    expect(within(member.panel).getByRole('note').textContent).toContain('never_tap')
    expect(within(member.panel).getByRole('note').textContent).toContain(
      'Only an owner or admin can activate it.',
    )
    const refused = within(member.panel).getByRole<HTMLButtonElement>('button', {
      name: 'Activate',
    })
    expect(refused.disabled).toBe(true)
    expect(
      within(member.panel).getByRole<HTMLButtonElement>('button', { name: 'Quarantine' }).disabled,
    ).toBe(false)
    cleanup()
    resetFakes()

    const owner = await openEditor(summary)
    await userEvent.click(within(owner.panel).getByRole('button', { name: 'Activate' }))
    await waitFor(() => expect(within(owner.panel).queryByRole('note')).toBeNull())
    expect(patches(owner.requests)).toEqual([{ status: 'active' }])
  })

  it('shows no status buttons to a viewer, and a hand-written test case without AI details', async () => {
    const { panel } = await openEditor(data.testCase('login', { status: 'draft' }), 'viewer')
    expect(within(panel).getByText('Written by hand')).toBeDefined()
    expect(within(panel).queryByRole('button')).toBeNull()
    expect(within(panel).queryByRole('link')).toBeNull()
    expect(within(panel).queryByTestId('validation-runs')).toBeNull()
  })

  it('lists what an exploration wrote, with their validation as it goes', async () => {
    const passed = written('open-cart', {
      status: 'active',
      validation: {
        commit: 'a'.repeat(40),
        runs: [
          { run_id: newId(), status: 'passed' },
          { run_id: newId(), status: 'passed' },
        ],
      },
    })
    const failed = written('open-about', {
      draft_reason: 'validation_failed',
      validation: {
        commit: 'a'.repeat(40),
        runs: [{ run_id: newId(), status: 'failed', failure_code: 'TIMEOUT', step_id: 's3' }],
      },
    })
    const waiting = written('open-menu')
    const flagged = written('place-order', { flags: ['needs_review_never_tap'] })
    const detail: api.ExplorationDetail = {
      id: explorationId,
      project_id: shop.id,
      app_id: newId(),
      build_id: newId(),
      device_id: newId(),
      kind: 'explore',
      goal: null,
      budget: { max_steps: 60, max_depth: 8, max_minutes: 20, max_cost_usd: 3 },
      max_tests: 5,
      status: 'validating',
      stop_reason: 'max_steps',
      stats: { ...api.EMPTY_EXPLORATION_STATS, tests_written: 4 },
      created_by: { id: TEST_USER.id, name: TEST_USER.name },
      created_at: at,
      started_at: at,
      finished_at: null,
      appmap: { screens: [], transitions: [] },
      test_cases: [passed, failed, waiting, flagged].map((t) => ({
        id: t.id,
        slug: t.slug,
        status: t.status,
        draft_reason: t.draft_reason,
        flags: t.flags,
        validation: t.validation,
      })),
      findings: [],
    }
    await renderApp(`/explorations/${explorationId}?tab=testcases`, {
      routes: {
        'GET /projects': [shop],
        'GET /devices': [],
        [`GET /explorations/${explorationId}`]: detail,
        [`GET /explorations/${explorationId}/steps`]: [],
      },
    })
    const table = await screen.findByRole('table', { name: 'Test cases' })
    const row = (slug: string) => {
      const cells = within(table)
        .getByRole('link', { name: slug })
        .closest('tr')
        ?.querySelectorAll('td')
      return [...(cells ?? [])].map((td) => td.textContent)
    }
    expect(row('open-cart')).toEqual(['open-cart', 'active', '2/2 passed', '—', '—'])
    expect(row('open-about')).toEqual([
      'open-about',
      'draft',
      'failed · at s3 · TIMEOUT',
      'validation_failed',
      '—',
    ])
    expect(row('open-menu')).toEqual(['open-menu', 'draft', 'validating…', '—', '—'])
    expect(row('place-order')).toEqual(['place-order', 'draft', '—', '—', 'needs_review_never_tap'])
    expect(within(table).getByRole('link', { name: 'open-cart' }).getAttribute('href')).toBe(
      `/projects/${shop.id}/testcases/${passed.id}`,
    )
  })
})
