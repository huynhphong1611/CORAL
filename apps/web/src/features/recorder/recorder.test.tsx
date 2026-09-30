import { newId, protocol, type api } from '@coral/shared'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as data from '../../testing/data'
import { renderApp, resetFakes, TEST_USER, type FakeRequest } from '../../testing/render-app'

afterEach(() => {
  cleanup()
  resetFakes()
  vi.restoreAllMocks()
})

beforeEach(() => {
  vi.stubGlobal('createImageBitmap', () =>
    Promise.resolve({ width: 540, height: 1200, close: () => undefined }),
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: () => undefined,
  } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 360,
    height: 800,
    right: 360,
    bottom: 800,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
})

const shop = data.project('Shop')
const device = data.device('Pixel 8')

function frame() {
  return [
    ...protocol.encodeFrame(
      {
        type: 'stream.frame',
        device_id: device.id,
        seq: 0,
        ts: Date.now(),
        width: 540,
        height: 1200,
        device_width: 1080,
        device_height: 2400,
        rotation: 0,
        mime: 'image/png',
      },
      new Uint8Array(8),
    ),
  ]
}

const menuTap = data.recordedStep(
  2,
  {
    id: 's2',
    action: 'tap',
    target: [
      { android_id: 'id/menuIV' },
      { image: { path: 'snap/recording/s2/element.png', screen_width: 1080 } },
    ],
  },
  {
    suggestions: [{ visible_text: 'Log In' }, { visible: { android_id: 'id/menuRV' } }],
    warnings: ['no_expect_after_tap'],
  },
)

/** The Recorder on a fake server whose recording follows PATCHes; `save` answers POST …/save. */
async function open(opts: { save?: (request: FakeRequest) => Response } = {}) {
  let current = data.recording(shop.id, device.id, {
    created_by: { id: TEST_USER.id, name: TEST_USER.name },
    steps: [data.recordedStep(1, { id: 's1', action: 'launch' }), menuTap],
  })
  const base = `/recordings/${current.id}`
  const app = await renderApp(base, {
    routes: {
      'GET /projects': [shop],
      'GET /devices': [device],
      [`GET ${base}`]: () => current,
      [`PATCH ${base}`]: (request) => {
        const body = request.body as Partial<api.Recording>
        const steps = body.steps?.map((s) => ({
          ...s,
          urls: { screen: `https://s3.test/${s.n}.jpg`, tree: `https://s3.test/${s.n}.json` },
        }))
        current = { ...current, ...body, ...(steps ? { steps } : {}) }
        return current
      },
      [`GET ${base}/yaml`]: () => ({ yaml: `id: ${current.slug}\n`, warnings: [] }),
      [`POST ${base}/save`]: (request) =>
        opts.save?.(request) ??
        Response.json(
          { test_case_id: newId(), head_commit: 'a'.repeat(40), warnings: [] },
          { status: 201 },
        ),
      [`GET /projects/${shop.id}/testcases`]: [
        data.testCase('recorded-login', { head_commit: 'b'.repeat(40) }),
      ],
      'GET /runs': { items: [], next_cursor: null },
    },
  })
  expect(await screen.findByRole('heading', { name: /^Recording / })).toBeDefined()
  return {
    ...app,
    recordingId: current.id,
    set: (next: Partial<api.Recording>) => (current = { ...current, ...next }),
    current: () => current,
  }
}

const stepsList = () => screen.getByRole('list', { name: 'Steps' })
const patches = (requests: FakeRequest[]) =>
  requests.filter((r) => r.method === 'PATCH').map((r) => r.body as Partial<api.Recording>)

describe('the Recorder (T044)', () => {
  it('records a click as a step and shows it once the server has it', async () => {
    const { server, recordingId, set, current } = await open()
    expect(within(stepsList()).getByText('launch')).toBeDefined()
    expect(within(stepsList()).getByText('tap id/menuIV')).toBeDefined()
    expect(screen.getByText('No expectation after this tap')).toBeDefined()

    act(() => server?.binary(frame()))
    const canvas = screen.getByTestId('live-canvas')
    await waitFor(() => expect(canvas.dataset.frames).toBe('1'))
    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 300, button: 0, pointerId: 1 })
    fireEvent.pointerUp(canvas, { clientX: 100, clientY: 300, button: 0, pointerId: 1 })
    const command = await waitFor(() => {
      const sent = server?.sent.find((m) => m.type === 'live.command')
      expect(sent).toBeDefined()
      return sent
    })
    expect(command?.payload).toEqual({
      recording_id: recordingId,
      command: { kind: 'tap', x: 300, y: 900 },
      record: true,
    })

    const login = data.recordedStep(3, {
      id: 's3',
      action: 'tap',
      target: [{ text: 'Log In' }],
    })
    set({ steps: [...(current().steps ?? []), login] })
    act(() => {
      server?.reply('live.result', { ok: true, command_id: newId(), duration_ms: 320 }, command?.id)
      server?.reply('recording.step', { recording_id: recordingId, step: login })
    })
    expect(await within(stepsList()).findByText('tap text “Log In”')).toBeDefined()

    act(() =>
      server?.reply('recording.step', {
        recording_id: recordingId,
        popup_rule: 'android_permission',
      }),
    )
    expect(
      await screen.findByText('Handled by popup rule android_permission — not recorded'),
    ).toBeDefined()

    // Home is done on the device but never recorded.
    await userEvent.click(screen.getByRole('button', { name: 'Home' }))
    await waitFor(() => {
      const home = server?.sent.filter((m) => m.type === 'live.command').at(-1)
      expect(home?.payload).toEqual({ recording_id: recordingId, command: { kind: 'home' } })
    })
  })

  it('accepts a suggestion and an Assert-mode pick as expectations (PATCH)', async () => {
    const { server, requests } = await open()
    await userEvent.click(
      screen.getByRole('button', { name: 'Add expectation text “Log In” to s2' }),
    )
    await waitFor(() => expect(patches(requests)).toHaveLength(1))
    const edited = patches(requests)[0]?.steps?.find((s) => s.n === 2)
    expect(edited).toMatchObject({
      step: { expect: [{ visible_text: 'Log In' }] },
      suggestions: [{ visible: { android_id: 'id/menuRV' } }],
      warnings: [],
    })
    expect(await within(stepsList()).findByText('Expect: text “Log In”')).toBeDefined()
    expect(screen.queryByText('No expectation after this tap')).toBeNull()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Assert mode' }))
    act(() => server?.binary(frame()))
    const canvas = screen.getByTestId('live-canvas')
    await waitFor(() => expect(canvas.dataset.frames).toBe('1'))
    fireEvent.pointerDown(canvas, { clientX: 20, clientY: 100, button: 0, pointerId: 1 })
    fireEvent.pointerUp(canvas, { clientX: 20, clientY: 100, button: 0, pointerId: 1 })
    const inspect = await waitFor(() => {
      const sent = server?.sent.find((m) => m.type === 'live.inspect')
      expect(sent).toBeDefined()
      return sent
    })
    expect(server?.sent.some((m) => m.type === 'live.command')).toBe(false)
    act(() =>
      server?.reply(
        'live.inspected',
        {
          element: {
            ref: '0.3',
            platform_id: 'com.saucelabs.mydemoapp.android:id/productTV',
            text: 'Products',
            desc: '',
            class: 'android.widget.TextView',
            bounds: { x: 40, y: 260, w: 600, h: 90 },
            clickable: false,
            enabled: true,
            visible: true,
            package_or_bundle: 'com.saucelabs.mydemoapp.android',
            children: [],
          },
          locators: [{ android_id: 'id/productTV' }, { text: 'Products' }],
          text: 'Products',
        },
        inspect?.id,
      ),
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Element not visible' }))
    await waitFor(() => expect(patches(requests)).toHaveLength(2))
    expect(patches(requests)[1]?.steps?.at(-1)?.step.expect).toEqual([
      { visible_text: 'Log In' },
      { not_visible: { android_id: 'id/productTV' } },
    ])
  })

  it('shows save problems on their step, offers Replace for a taken slug, then saves', async () => {
    let attempt = 0
    const bodies: unknown[] = []
    const { requests, router } = await open({
      save: (request) => {
        bodies.push(request.body)
        attempt += 1
        if (attempt === 1) {
          return Response.json(
            {
              error: {
                code: 'validation_failed',
                message: 'YAML is not valid',
                details: [
                  {
                    path: 'steps[1].target[1].image',
                    code: 'image_not_found',
                    message: 'no such file in the project',
                    step_id: 's2',
                  },
                ],
              },
            },
            { status: 400 },
          )
        }
        if (attempt === 2) {
          return Response.json(
            { error: { code: 'slug_exists', message: 'test case exists' } },
            { status: 409 },
          )
        }
        return Response.json(
          { test_case_id: newId(), head_commit: 'c'.repeat(40), warnings: [] },
          { status: 201 },
        )
      },
    })
    const slug = screen.getByLabelText('Slug')
    await userEvent.clear(slug)
    await userEvent.type(slug, 'recorded-login')
    await userEvent.type(screen.getByLabelText('Intent'), 'Open the menu')
    await userEvent.click(screen.getByRole('button', { name: 'Save as test case' }))
    const s2 = await screen.findByTestId('step-s2')
    expect(
      await within(s2).findByText('image_not_found: no such file in the project'),
    ).toBeDefined()
    expect(patches(requests).at(-1)).toMatchObject({
      slug: 'recorded-login',
      intent: 'Open the menu',
    })

    await userEvent.click(screen.getByRole('button', { name: 'Save as test case' }))
    expect(await screen.findByText('A test case “recorded-login” already exists.')).toBeDefined()
    expect(within(screen.getByTestId('step-s2')).queryByRole('alert')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Replace recorded-login' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${shop.id}`))
    expect(bodies.at(-1)).toMatchObject({
      slug: 'recorded-login',
      intent: 'Open the menu',
      replace: true,
      base_commit: 'b'.repeat(40),
    })
  })

  it('restores a stopped recording and lets its author resume it', async () => {
    const { set, queryClient, recordingId } = await open()
    set({ status: 'stopped' })
    await act(() => queryClient.invalidateQueries({ queryKey: ['recordings', recordingId] }))
    expect(
      await screen.findByText('Stopped — the device is free. Resume to record more.'),
    ).toBeDefined()
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDefined()
    expect(screen.queryByRole('checkbox', { name: 'Assert mode' })).toBeNull()
  })
})
