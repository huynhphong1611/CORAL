import { api, newId, type TransitionAction } from '@coral/shared'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as data from '../../testing/data'
import { calls, renderApp, resetFakes, TEST_USER } from '../../testing/render-app'

afterEach(() => {
  cleanup()
  resetFakes()
  vi.restoreAllMocks()
})

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: () => undefined,
  } as unknown as CanvasRenderingContext2D)
})

const at = '2026-10-01T10:00:00.000Z'
const shop = data.project('Shop')
const pixel = data.device('Pixel 8')

function exploration(over: Partial<api.ExplorationDetail> = {}): api.ExplorationDetail {
  return {
    id: newId(),
    project_id: shop.id,
    app_id: newId(),
    build_id: newId(),
    device_id: pixel.id,
    kind: 'explore',
    goal: null,
    budget: { max_steps: 60, max_depth: 8, max_minutes: 20, max_cost_usd: 3 },
    max_tests: 5,
    status: 'running',
    stop_reason: null,
    stats: { ...api.EMPTY_EXPLORATION_STATS },
    created_by: { id: TEST_USER.id, name: TEST_USER.name },
    created_at: at,
    started_at: at,
    finished_at: null,
    appmap: { screens: [], transitions: [] },
    test_cases: [],
    findings: [],
    ...over,
  }
}

function step(n: number, over: Partial<api.ExplorationStepView> = {}): api.ExplorationStepView {
  return {
    n,
    segment: 1,
    screen: { id: 'catalog', name: 'Catalog', fingerprint: '0123456789abcdef' },
    decision: { action: 'tap', element: 1, reason: 'Open the menu, not tried yet' },
    status: 'done',
    refusal: null,
    step: { id: `s${n}`, action: 'tap', target: [{ android_id: 'id/menuIV' }] },
    flags: [],
    brain_call_id: newId(),
    screenshot_url: `https://s3.test/explorations/${n}/screen.jpg`,
    cost_usd: 0.02,
    created_at: at,
    ...over,
  }
}

function brainCall(id: string, content: api.BrainCallContent | null): api.BrainCall {
  return {
    id,
    role: 'explorer',
    provider: 'fake',
    model: 'fake',
    attempt: 1,
    ok: true,
    error: null,
    tokens_in: 900,
    tokens_out: 40,
    cost_usd: 0.02,
    latency_ms: 12,
    created_at: at,
    content,
    tool_calls: [],
  }
}

const content: api.BrainCallContent = {
  role: 'explorer',
  provider: 'fake',
  model: 'fake',
  attempt: 1,
  system: { stable_hash: 'abc', volatile: 'Goal: none' },
  messages: [
    {
      role: 'user',
      text: '#1 ImageView id="menuIV" desc="View menu" [24,110,110,110] new',
      image: 'https://s3.test/explorations/1/ai.jpg',
    },
  ],
  rounds: [],
  answer: '{"action":"tap","element":1}',
  validation_errors: [],
  decision: { action: 'tap', element: 1, reason: 'Open the menu, not tried yet' },
}

async function open(
  detail: api.ExplorationDetail,
  tab: string,
  steps: api.ExplorationStepView[] = [],
) {
  const calls: Record<string, api.BrainCall> = {}
  // What GET /explorations/:id answers now (a test moves it on, like the server would).
  const state = { detail }
  const app = await renderApp(`/explorations/${detail.id}?tab=${tab}`, {
    routes: {
      'GET /projects': [shop],
      'GET /devices': [pixel],
      [`GET /explorations/${detail.id}`]: () => state.detail,
      [`GET /explorations/${detail.id}/steps`]: steps,
      [`POST /explorations/${detail.id}/stop`]: { ...detail, status: 'stopped' },
      ...Object.fromEntries(
        steps
          .filter((s) => s.brain_call_id)
          .map((s) => [`GET /brain-calls/${s.brain_call_id}`, () => calls[s.brain_call_id ?? '']]),
      ),
    },
  })
  return { ...app, calls, state }
}

describe('exploration page (T034)', () => {
  it('follows the exploration live: totals, cost against the budget, what it does now', async () => {
    const detail = exploration()
    const { server, state } = await open(detail, 'progress')
    expect((await screen.findByTestId('exploration-steps')).textContent).toContain('0 / 60')
    await waitFor(() =>
      expect(server?.sent.find((m) => m.type === 'exploration.watch')?.payload).toEqual({
        exploration_id: detail.id,
      }),
    )
    act(() =>
      server?.reply('exploration.updated', {
        exploration_id: detail.id,
        status: 'running',
        stats: { ...detail.stats, steps: 3, screens: 2, new_screens: 2, cost_usd: 0.42 },
        current: { n: 3, screen_name: 'Menu', action_summary: 'tap "Log In" (#10)' },
      }),
    )
    // The query cache tells React on its own schedule.
    await waitFor(() =>
      expect(screen.getByTestId('exploration-steps').textContent).toContain('3 / 60'),
    )
    expect(screen.getByTestId('exploration-cost').textContent).toContain('$0.42 / $3.00')
    expect(screen.getByTestId('exploration-current').textContent).toContain(
      'Menu: tap "Log In" (#10)',
    )
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Stop' }).disabled).toBe(false)

    state.detail = { ...detail, status: 'done', stop_reason: 'max_steps', finished_at: at }
    act(() =>
      server?.reply('exploration.updated', {
        exploration_id: detail.id,
        status: 'done',
        stop_reason: 'max_steps',
        stats: { ...detail.stats, steps: 60, cost_usd: 1.2 },
      }),
    )
    expect((await screen.findByTestId('exploration-stop-reason')).textContent).toContain(
      'step budget used',
    )
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('stops on request and hides Stop from viewers', async () => {
    const detail = exploration()
    const { requests } = await open(detail, 'progress')
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(calls(requests)).toContain(`POST /explorations/${detail.id}/stop`))
    cleanup()
    resetFakes()
    await renderApp(`/explorations/${detail.id}`, {
      role: 'viewer',
      routes: {
        'GET /projects': [shop],
        'GET /devices': [pixel],
        [`GET /explorations/${detail.id}`]: detail,
        [`GET /explorations/${detail.id}/steps`]: [],
      },
    })
    expect(await screen.findByTestId('exploration-steps')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('shows the trace, adds steps as they come and opens what the AI saw and answered', async () => {
    const detail = exploration()
    const first = step(1)
    const expired = step(2, { decision: { action: 'back', reason: 'Nothing new here' } })
    const { server, calls: answers } = await open(detail, 'trace', [first, expired])
    answers[first.brain_call_id ?? ''] = brainCall(first.brain_call_id ?? '', content)
    answers[expired.brain_call_id ?? ''] = brainCall(expired.brain_call_id ?? '', null)

    const table = await screen.findByRole('table', { name: 'Trace' })
    expect(within(table).getByText('tap #1')).toBeTruthy()
    act(() =>
      server?.reply('exploration.step', {
        exploration_id: detail.id,
        step: step(3, {
          decision: { action: 'tap', element: 9, reason: 'Place Order looks interesting' },
          status: 'refused',
          refusal: 'never_tap',
          step: null,
          cost_usd: 0.01,
        }),
      }),
    )
    expect(await within(table).findByText('refused: never_tap')).toBeTruthy()

    await userEvent.click(within(table).getByText('tap #1'))
    expect(await screen.findByText('What the AI answered')).toBeTruthy()
    expect(screen.getByText('Open the menu, not tried yet', { selector: 'p' })).toBeTruthy()
    expect(screen.getByAltText('What the AI saw').getAttribute('src')).toBe(
      'https://s3.test/explorations/1/ai.jpg',
    )
    expect(screen.getByText(/menuIV/, { selector: 'pre' })).toBeTruthy()

    await userEvent.click(within(table).getByText('back'))
    expect(await screen.findByText('Content expired (kept 30 days)')).toBeTruthy()

    const system = step(4, {
      decision: null,
      brain_call_id: null,
      step: { id: 's4', action: 'back' },
    })
    act(() => server?.reply('exploration.step', { exploration_id: detail.id, step: system }))
    await userEvent.click(await within(table).findByText('system', { exact: false }))
    expect(
      await screen.findByText('The system took this step on its own, without the AI.'),
    ).toBeTruthy()
  })

  it('shows the app map and the findings', async () => {
    const detail = exploration({
      status: 'done',
      stop_reason: 'max_steps',
      appmap: {
        screens: [
          {
            id: 'catalog',
            name: 'Catalog',
            fingerprint: '0123456789abcdef',
            is_new: true,
            screenshot_url: 'https://s3.test/1/screen.jpg',
          },
          {
            id: 'menu',
            name: 'Menu',
            fingerprint: 'fedcba9876543210',
            is_new: false,
            screenshot_url: 'https://s3.test/2/screen.jpg',
          },
        ],
        transitions: [
          {
            from: 'catalog',
            to: 'menu',
            action: {
              action: 'tap',
              target: [{ desc: 'View menu' }],
            } as unknown as TransitionAction,
          },
        ],
      },
      findings: [
        {
          id: newId(),
          step_n: 7,
          kind: 'crashed',
          log_excerpt: 'FATAL EXCEPTION: main',
          screenshot_url: 'https://s3.test/7/screen.jpg',
          created_at: at,
        },
      ],
    })
    await open(detail, 'appmap')
    const grid = await screen.findByRole('list', { name: 'App map' })
    expect(within(grid).getByAltText('Catalog')).toBeTruthy()
    expect(within(grid).getByText('New')).toBeTruthy()
    expect(within(grid).getByText('Known')).toBeTruthy()
    expect(screen.getByRole('list', { name: 'Transitions' }).textContent).toContain(
      'Catalog → Menutap {"desc":"View menu"}',
    )
    await userEvent.click(screen.getByRole('tab', { name: 'Findings' }))
    expect(await screen.findByText('FATAL EXCEPTION: main')).toBeTruthy()
    expect(screen.getByText('at step 7')).toBeTruthy()
  })
})

describe('start exploration (T034)', () => {
  const app = data.app(shop.id)
  const build = data.build(app.id)
  const routes = {
    'GET /projects': [shop],
    'GET /devices': [pixel],
    [`GET /projects/${shop.id}/apps`]: [app],
    [`GET /apps/${app.id}/builds`]: [build],
  }

  it('starts with the defaults; a goal asks for one test case', async () => {
    const created = exploration({ kind: 'prompt', goal: 'Log in with the demo account' })
    const { requests } = await renderApp(`/projects/${shop.id}/explore`, {
      routes: {
        ...routes,
        'POST /explorations': created,
        [`GET /explorations/${created.id}`]: created,
        [`GET /explorations/${created.id}/steps`]: [],
      },
    })
    const start = await screen.findByRole<HTMLButtonElement>('button', { name: 'Start' })
    await waitFor(() => expect(start.disabled).toBe(false))
    expect(screen.getByLabelText<HTMLInputElement>('Max test cases').value).toBe(String(5))
    await userEvent.type(screen.getByLabelText('Goal (optional)'), 'Log in with the demo account')
    expect(screen.getByLabelText<HTMLInputElement>('Max test cases').value).toBe(String(1))
    await userEvent.click(start)
    await screen.findByTestId('exploration-steps')
    expect(requests.find((r) => r.url.pathname === '/api/explorations')?.body).toEqual({
      project_id: shop.id,
      app_id: app.id,
      build_id: build.id,
      device_id: pixel.id,
      goal: 'Log in with the demo account',
      budget: { max_steps: 60, max_depth: 8, max_minutes: 20 },
      max_tests: 1,
    })
  })

  it('says when AI is not configured', async () => {
    await renderApp(`/projects/${shop.id}/explore`, {
      routes: {
        ...routes,
        'POST /explorations': Response.json(
          { error: { code: 'brains_not_configured', message: 'AI is not configured' } },
          { status: 409 },
        ),
      },
    })
    const start = await screen.findByRole<HTMLButtonElement>('button', { name: 'Start' })
    await waitFor(() => expect(start.disabled).toBe(false))
    await userEvent.click(start)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('AI is not configured for this tenant.')
    expect(
      within(alert).getByRole('link', { name: 'Configure the brains' }).getAttribute('href'),
    ).toBe('/settings/brains')
  })
})
