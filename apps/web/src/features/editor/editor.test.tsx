import { newId, type api } from '@coral/shared'
import { forEachDiagnostic } from '@codemirror/lint'
import { EditorView } from '@codemirror/view'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as data from '../../testing/data'
import { renderApp, resetFakes, type FakeRequest } from '../../testing/render-app'

afterEach(() => {
  cleanup()
  resetFakes()
  vi.restoreAllMocks()
})

beforeEach(() => {
  // jsdom has no layout: CodeMirror measures ranges, the snapshots become object URLs.
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null })
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  let n = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:snapshot-${(n += 1)}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})

const shop = data.project('Shop')
const HEAD = 'a'.repeat(40)
const NEXT = 'b'.repeat(40)
const runId = newId()

const YAML = `schema: coral/testcase@1
id: login
intent: Log in
platforms: [android]
steps:
  - id: s1
    action: launch
  - id: s2
    action: tap
    target: [{ text: Login }]
  - id: s3
    action: tap
    target: [{ android_id: id/loginBtn }]
    expect: { visible_text: Products }
`

/** The editor on a fake server; `put` answers PUT /testcases/:id. */
async function open(
  opts: { role?: string; put?: (request: FakeRequest) => Response; latest?: string } = {},
) {
  const summary = data.testCase('login', { head_commit: HEAD, intent: 'Log in' })
  const detail: api.TestCaseDetail = { ...summary, yaml: YAML }
  const base = `/testcases/${summary.id}`
  let puts = 0
  const history: api.HistoryEntry[] = [
    {
      commit: HEAD,
      author: 'Huynh <huynh@coral.test>',
      message: 'testcase: login',
      created_at: summary.updated_at,
    },
  ]
  const app = await renderApp(`/projects/${shop.id}`, {
    ...(opts.role ? { role: opts.role } : {}),
    routes: {
      'GET /projects': [shop],
      [`GET /projects/${shop.id}/testcases`]: [summary],
      // Someone else's version (`latest`) is there once a save was tried.
      [`GET ${base}`]: () =>
        opts.latest && puts > 0 ? { ...detail, yaml: opts.latest, head_commit: NEXT } : detail,
      [`GET ${base}/snapshots`]: [
        {
          step_id: 's1',
          screen_url: `${base}/files/snap/login/s1/screen.jpg?commit=${HEAD}`,
          tree_url: `${base}/files/snap/login/s1/tree.json?commit=${HEAD}`,
          element_url: null,
        },
      ],
      [`GET ${base}/files/snap/login/s1/screen.jpg`]: () =>
        new Response(new Uint8Array([0xff, 0xd8]), { headers: { 'content-type': 'image/jpeg' } }),
      [`GET ${base}/last-run-steps`]: [
        {
          step_id: 's2',
          screenshot_url: 'https://s3.test/run/s2.png',
          run_id: runId,
          finished_at: '2026-09-30T05:41:47.000Z',
        },
      ],
      [`GET ${base}/history`]: () => history,
      [`PUT ${base}`]: (request) => {
        puts += 1
        const answer = opts.put?.(request) ?? Response.json({ head_commit: NEXT, warnings: [] })
        if (answer.ok) {
          history.unshift({
            commit: NEXT,
            author: 'Huynh <huynh@coral.test>',
            message: 'testcase: login',
            created_at: '2026-09-30T06:00:00.000Z',
          })
        }
        return answer
      },
    },
  })
  // From the project's test cases, the slug opens the editor.
  await userEvent.click(await screen.findByRole('link', { name: 'login' }))
  expect(await screen.findByRole('heading', { name: 'login' })).toBeDefined()
  await waitFor(() => expect(view().state.doc.toString()).toBe(YAML))
  return { ...app, id: summary.id }
}

const view = () => {
  const found = EditorView.findFromDOM(screen.getByTestId('yaml-editor'))
  if (!found) throw new Error('no editor')
  return found
}
/** Replaces the editor's text as if typed. */
const edit = (text: string) =>
  act(() => view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: text } }))
const saveButton = () => screen.getByRole('button', { name: 'Save' })
/** Lines of the editor's error diagnostics. */
const errorLines = () => {
  const lines: number[] = []
  forEachDiagnostic(view().state, (d, from) => {
    if (d.severity === 'error') lines.push(view().state.doc.lineAt(from).number)
  })
  return lines
}

describe('the test case editor (T048)', () => {
  it('shows the YAML and a picture beside each step: snapshot, last run, or none', async () => {
    const { requests } = await open()
    const s1 = await screen.findByTestId('picture-s1')
    const snapshot = await within(s1).findByRole('img', { name: 'Screen of step s1' })
    expect(snapshot.getAttribute('src')).toMatch(/^blob:snapshot-/)
    expect(within(s1).getByText('Recorded')).toBeDefined()
    // The snapshot is fetched with the token, pinned to the head commit.
    const file = requests.find((r) => r.url.pathname.endsWith('/s1/screen.jpg'))
    expect(file?.url.search).toBe(`?commit=${HEAD}`)

    const s2 = screen.getByTestId('picture-s2')
    expect(
      (await within(s2).findByRole('img', { name: 'Screen of step s2' })).getAttribute('src'),
    ).toBe('https://s3.test/run/s2.png')
    expect(within(s2).getByText(new RegExp(`^Run ${runId.slice(-8)}`))).toBeDefined()
    expect(within(screen.getByTestId('picture-s3')).getByText('No image yet')).toBeDefined()

    expect(await screen.findByText('Valid')).toBeDefined()
    expect(saveButton()).toHaveProperty('disabled', true)
  })

  it('marks problems on their line within a second and locks Save until fixed', async () => {
    await open()
    edit(
      YAML.replace(
        'expect: { visible_text: Products }',
        'expect: { visible_text: Products, timeout_ms: 5 }',
      ),
    )
    const errors = await screen.findByRole('list', { name: 'Errors' }, { timeout: 1000 })
    expect(within(errors).getByText(/^Line 14:/)).toBeDefined()
    expect(within(errors).getByText(/s3/)).toBeDefined()
    expect(errorLines()).toEqual([14])
    // The problem's place takes the cursor there.
    await userEvent.click(within(errors).getByRole('button', { name: /^Line 14:/ }))
    const { head } = view().state.selection.main
    expect(view().state.doc.lineAt(head).number).toBe(14)
    expect(saveButton()).toHaveProperty('disabled', true)
    expect(screen.getByText('1 problem — fix it to save')).toBeDefined()

    edit(YAML.replace('id: login', 'id: logout'))
    expect(await screen.findByText(/id must stay "login"/)).toBeDefined()
    expect(errorLines()).toEqual([2])

    edit(YAML.replace('Log in', 'Log in with the demo account'))
    await waitFor(() => expect(saveButton()).toHaveProperty('disabled', false))
    expect(errorLines()).toEqual([])
    expect(screen.getByText('Unsaved changes')).toBeDefined()
  })

  it('saves as a commit on the base it opened, then History shows it on top', async () => {
    const bodies: unknown[] = []
    await open({
      put: (request) => (
        bodies.push(request.body),
        Response.json({ head_commit: NEXT, warnings: [] })
      ),
    })
    const changed = YAML.replace('Log in', 'Log in with the demo account')
    edit(changed)
    await waitFor(() => expect(saveButton()).toHaveProperty('disabled', false))
    await userEvent.click(saveButton())
    expect(await screen.findByText(/^Saved/)).toBeDefined()
    expect(bodies).toEqual([{ yaml: changed, base_commit: HEAD }])
    expect(saveButton()).toHaveProperty('disabled', true)
    expect(screen.queryByText('Unsaved changes')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'History' }))
    const history = await screen.findByRole('list', { name: 'History' })
    const [top, previous] = within(history).getAllByRole('listitem')
    expect(top?.textContent).toContain(NEXT.slice(0, 7))
    expect(within(top ?? history).getByText('current')).toBeDefined()
    expect(previous?.textContent).toContain(HEAD.slice(0, 7))

    // The next save is based on the new head.
    edit(`${changed}# more\n`)
    await waitFor(() => expect(saveButton()).toHaveProperty('disabled', false))
    await userEvent.click(saveButton())
    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1]).toMatchObject({ base_commit: NEXT })
  })

  it('on a conflict keeps the edits and offers the latest version', async () => {
    const theirs = YAML.replace('Log in', 'Log in, theirs')
    await open({
      latest: theirs,
      put: () =>
        Response.json(
          { error: { code: 'stale_base_commit', message: 'test case changed since base_commit' } },
          { status: 409 },
        ),
    })
    const mine = YAML.replace('Log in', 'Log in, mine')
    edit(mine)
    await waitFor(() => expect(saveButton()).toHaveProperty('disabled', false))
    await userEvent.click(saveButton())
    expect(await screen.findByText(/^Changed by someone else/)).toBeDefined()
    expect(view().state.doc.toString()).toBe(mine)

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await userEvent.click(screen.getByRole('button', { name: 'Load latest version' }))
    await waitFor(() => expect(view().state.doc.toString()).toBe(theirs))
    expect(screen.queryByText(/^Changed by someone else/)).toBeNull()
  })

  it('shows what the server refused (an image not in the repo) until the text changes', async () => {
    await open({
      put: () =>
        Response.json(
          {
            error: {
              code: 'validation_failed',
              message: 'YAML is not valid',
              details: [
                {
                  path: 'steps[2].target[0].image',
                  code: 'image_not_found',
                  message: '"snap/login/s3/element.png" is not in the project repo',
                  step_id: 's3',
                  line: 13,
                  column: 15,
                },
              ],
            },
          },
          { status: 400 },
        ),
    })
    edit(YAML.replace('Log in', 'Log in again'))
    await waitFor(() => expect(saveButton()).toHaveProperty('disabled', false))
    await userEvent.click(saveButton())
    expect(await screen.findByText(/image_not_found/)).toBeDefined()
    expect(errorLines()).toEqual([13])
    expect(saveButton()).toHaveProperty('disabled', true)
    edit(YAML.replace('Log in', 'Log in once more'))
    await waitFor(() => expect(screen.queryByText(/image_not_found/)).toBeNull())
  })

  it('is read only for a viewer', async () => {
    await open({ role: 'viewer' })
    expect(screen.getByText(/^Read only/)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(view().state.readOnly).toBe(true)
  })
})
