import type { api } from '@coral/shared'
import { newId, type ManualCase } from '@coral/shared'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as data from '../../testing/data'
import { calls, renderApp, resetFakes, TEST_USER } from '../../testing/render-app'

// US6 (T055): imports in the web app — the project's Imports tab, a file read into a preview
// (columns chosen again, rows left out with why), started on a device; then the job live: its
// progress, each case with why it stayed draft and the test case it became, Cancel, the report.

afterEach(() => {
  cleanup()
  resetFakes()
  vi.restoreAllMocks()
})

const at = '2026-10-02T09:00:00.000Z'
const shop = data.project('Shop')
const app = data.app(shop.id)
const build = data.build(app.id)
const pixel = data.device('Pixel 8')
const jobId = newId()

const manual = (
  id: string,
  title: string,
  steps: ManualCase['steps'],
  row: number,
): ManualCase => ({
  schema: 'coral/manualcase@1',
  id,
  title,
  preconditions: [],
  steps,
  tags: [],
  source: { file: 'cases.csv', row },
})

const preview = (over: Partial<api.ImportPreview> = {}): api.ImportPreview => ({
  import_job_id: jobId,
  format: 'csv',
  file_name: 'cases.csv',
  columns: [
    { index: 0, header: 'Case' },
    { index: 1, header: 'What to do' },
    { index: 2, header: 'Expected' },
  ],
  mapping: null,
  cases: [],
  errors: [{ code: 'no_mapping', message: 'cannot tell which columns hold the titles' }],
  ...over,
})

function job(over: Partial<api.ImportJobDetail> = {}): api.ImportJobDetail {
  return {
    id: jobId,
    project_id: shop.id,
    app_id: app.id,
    build_id: build.id,
    device_id: pixel.id,
    source_format: 'csv',
    file_name: 'cases.csv',
    status: 'running',
    budget: { max_cost_usd: 10, max_minutes: 240 },
    stats: { total: 3, done: 1, active: 1, draft: 0, not_processed: 0, cost_usd: 0.42 },
    manual_commit: 'a'.repeat(40),
    created_by: { id: TEST_USER.id, name: TEST_USER.name },
    created_at: at,
    started_at: at,
    finished_at: null,
    items: [],
    report: null,
    ...over,
  }
}

const routes = {
  'GET /projects': [shop],
  'GET /devices': [pixel],
  [`GET /projects/${shop.id}/apps`]: [app],
  [`GET /apps/${app.id}/builds`]: [build],
}

describe('new import (T055)', () => {
  it('reads a file, asks for the columns, shows the cases and rows left out, starts', async () => {
    const remapped = preview({
      mapping: { title: 0, steps: [1], expected: [2], header_row: 0 },
      cases: [
        manual('001', 'Open the cart', [{ action: 'Tap the cart icon', expected: 'My Cart' }], 2),
      ],
      errors: [{ row: 3, code: 'missing_steps', message: '"Open the menu" has no step' }],
    })
    const { requests, router } = await renderApp(`/projects/${shop.id}/imports/new`, {
      routes: {
        ...routes,
        [`POST /projects/${shop.id}/imports`]: preview(),
        [`PATCH /imports/${jobId}`]: remapped,
        [`POST /imports/${jobId}/start`]: job({ items: [] }),
        [`GET /imports/${jobId}`]: job(),
      },
    })
    expect(await screen.findByRole('heading', { name: 'Import manual test cases' })).toBeDefined()
    const read = screen.getByRole<HTMLButtonElement>('button', { name: 'Read the file' })
    expect(read.disabled).toBe(true)
    await userEvent.upload(
      screen.getByLabelText('File'),
      new File(['Case,What to do\n'], 'cases.csv', { type: 'text/csv' }),
    )
    await userEvent.click(read)

    // Nothing guessed: the person chooses the columns, then the file is read again.
    expect(await screen.findByTestId('import-cases-count')).toHaveProperty(
      'textContent',
      '0 test cases read',
    )
    expect(screen.getByRole('list', { name: 'Left out' }).textContent).toContain('no_mapping')
    const again = screen.getByRole<HTMLButtonElement>('button', { name: 'Read again' })
    expect(again.disabled).toBe(true)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Title' }), '0')
    const steps = screen.getByRole('group', { name: 'Steps' })
    await userEvent.click(within(steps).getByRole('checkbox', { name: 'What to do' }))
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Expected result' })).getByRole('checkbox', {
        name: 'Expected',
      }),
    )
    await userEvent.click(again)
    await waitFor(() =>
      expect(screen.getByTestId('import-cases-count').textContent).toBe('1 test case read'),
    )
    expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({
      mapping: { title: 0, steps: [1], expected: [2], header_row: 0 },
    })
    const cases = screen.getByRole('table', { name: 'Test cases read' })
    expect(cases.textContent).toContain('Open the cart')
    expect(cases.textContent).toContain('Tap the cart icon → My Cart')
    expect(screen.getByRole('list', { name: 'Left out' }).textContent).toContain(
      'Row 3 · missing_steps',
    )

    // Then the device and budget, and Start.
    const start = screen.getByRole<HTMLButtonElement>('button', { name: 'Start' })
    await waitFor(() => expect(start.disabled).toBe(false))
    await userEvent.type(screen.getByLabelText('Cost (USD)'), '5')
    await userEvent.click(start)
    await waitFor(() => expect(router.state.location.pathname).toBe(`/imports/${jobId}`))
    expect(requests.find((r) => r.url.pathname.endsWith('/start'))?.body).toEqual({
      app_id: app.id,
      build_id: build.id,
      device_id: pixel.id,
      budget: { max_cost_usd: 5, max_minutes: 240 },
    })
  })

  it('discards a preview', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { requests, router } = await renderApp(`/projects/${shop.id}/imports/new`, {
      routes: {
        ...routes,
        [`POST /projects/${shop.id}/imports`]: preview({
          format: 'gherkin',
          columns: [],
          errors: [],
          cases: [manual('001', 'Open the cart', [{ action: 'I tap the cart icon' }], 2)],
        }),
        [`DELETE /imports/${jobId}`]: () => new Response(null, { status: 204 }),
        'GET /imports': [],
      },
    })
    await userEvent.upload(
      await screen.findByLabelText('File'),
      new File(['Feature: Shop\n'], 'shop.feature'),
    )
    await userEvent.click(screen.getByRole('button', { name: 'Read the file' }))
    expect(await screen.findByText('1 test case read')).toBeDefined()
    // Gherkin has no columns to choose.
    expect(screen.queryByRole('button', { name: 'Read again' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(calls(requests)).toContain(`DELETE /imports/${jobId}`))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${shop.id}`))
  })
})

describe('import job (T055)', () => {
  const items: api.ImportItem[] = [
    {
      n: 1,
      title: 'Open the cart',
      status: 'active',
      reason: null,
      evidence: null,
      exploration_id: newId(),
      test_case_id: newId(),
    },
    {
      n: 2,
      title: 'Log in with a code sent by SMS',
      status: 'draft',
      reason: 'needs_human',
      evidence: {
        step_n: 1,
        screenshot_url: 'https://s3.test/step-1.jpg',
        message: 'A person has to give a code sent to a phone (OTP, SMS)',
      },
      exploration_id: newId(),
      test_case_id: null,
    },
    {
      n: 3,
      title: 'Open the menu',
      status: 'running',
      reason: null,
      evidence: null,
      exploration_id: newId(),
      test_case_id: null,
    },
  ]

  it('follows the job live, says why a case stayed draft, cancels', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const state = { detail: job({ items }) }
    const { requests, server } = await renderApp(`/imports/${jobId}`, {
      routes: {
        ...routes,
        [`GET /imports/${jobId}`]: () => state.detail,
        [`POST /imports/${jobId}/cancel`]: () => state.detail,
      },
    })
    expect(await screen.findByRole('heading', { name: 'Import cases.csv' })).toBeDefined()
    expect(screen.getByTestId('import-progress').textContent).toBe('1 / 3')
    await waitFor(() =>
      expect(server?.sent.find((m) => m.type === 'import.watch')?.payload).toEqual({
        import_job_id: jobId,
      }),
    )
    const table = screen.getByRole('table', { name: 'Test cases' })
    const [, cart, sms] = within(table).getAllByRole('row')
    expect(
      within(cart ?? table)
        .getByRole('link', { name: 'Open' })
        .getAttribute('href'),
    ).toBe(`/projects/${shop.id}/testcases/${items[0]?.test_case_id}`)
    expect(sms?.textContent).toContain('needs a person')
    expect(sms?.textContent).toContain('A person has to give a code')
    expect(
      within(sms ?? table)
        .getByRole('link', { name: 'step 1' })
        .getAttribute('href'),
    ).toBe(`/explorations/${items[1]?.exploration_id}?tab=trace`)
    expect(
      within(sms ?? table)
        .getByAltText('What the app showed')
        .getAttribute('src'),
    ).toBe('https://s3.test/step-1.jpg')

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(calls(requests)).toContain(`POST /imports/${jobId}/cancel`))

    // The job ends: the page reads it again, the report shows.
    state.detail = job({
      status: 'cancelled',
      stats: { total: 3, done: 3, active: 1, draft: 1, not_processed: 1, cost_usd: 0.6 },
      finished_at: at,
      items: items.map((i) => (i.n === 3 ? { ...i, status: 'not_processed' } : i)),
      report: {
        total: 3,
        active: 1,
        draft: {
          needs_human: 1,
          ambiguous: 0,
          app_mismatch: 0,
          validation_failed: 0,
          duplicate: 0,
        },
        not_processed: 1,
        cost_usd: 0.6,
        items: [],
      },
    })
    act(() =>
      server?.reply('import.updated', {
        import_job_id: jobId,
        status: 'cancelled',
        stats: state.detail.stats,
      }),
    )
    const report = await screen.findByTestId('import-report')
    expect(report.textContent).toContain('1 of 3 test cases active')
    expect(report.textContent).toContain('needs a person: 1')
    expect(report.textContent).toContain('Not processed: 1')
    expect(screen.getByTestId('import-status').textContent).toBe('cancelled')
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('lists the imports of the project; viewers cannot import', async () => {
    await renderApp(`/projects/${shop.id}?tab=imports`, {
      role: 'viewer',
      routes: { ...routes, 'GET /imports': [job()] },
    })
    const table = await screen.findByRole('table', { name: 'Imports' })
    expect(within(table).getByRole('link', { name: 'cases.csv' }).getAttribute('href')).toBe(
      `/imports/${jobId}`,
    )
    expect(table.textContent).toContain('1 / 3')
    expect(screen.queryByRole('link', { name: 'Import test cases' })).toBeNull()
  })
})
