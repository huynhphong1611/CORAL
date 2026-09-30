import { newId, protocol, type api } from '@coral/shared'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as data from '../testing/data'
import type { FakeSocket } from '../testing/fake-socket'
import { renderApp, resetFakes, TEST_USER } from '../testing/render-app'

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
  // The frame is drawn 360×800 CSS px at the page's top-left corner.
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

const since = '2026-09-29T08:00:00.000Z'

function sessionOf(deviceId: string, user = TEST_USER): api.ControlSession {
  return {
    live_session_id: newId(),
    device_id: deviceId,
    user: { id: user.id, name: user.name },
    started_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    idle_timeout_ms: 600_000,
  }
}

function frame(deviceId: string) {
  return [
    ...protocol.encodeFrame(
      {
        type: 'stream.frame',
        device_id: deviceId,
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

/** The device page with a control API: `taken` answers POST (a session or a Response). */
async function open(opts: { role?: string; device?: api.DeviceView; taken?: Response } = {}) {
  const device = opts.device ?? data.device('Pixel 8')
  let current: api.ControlSession | null = null
  const app = await renderApp(`/devices/${device.id}`, {
    ...(opts.role ? { role: opts.role } : {}),
    routes: {
      'GET /devices': [device],
      [`GET /devices/${device.id}/control`]: () =>
        current ??
        Response.json({ error: { code: 'not_found', message: 'none' } }, { status: 404 }),
      [`POST /devices/${device.id}/control`]: () => {
        if (opts.taken) return opts.taken
        current = sessionOf(device.id)
        return Response.json(current, { status: 201 })
      },
      [`DELETE /devices/${device.id}/control`]: () => {
        current = null
        return new Response(null, { status: 204 })
      },
    },
  })
  expect(await screen.findByRole('heading', { name: device.model })).toBeDefined()
  return { ...app, device, session: () => current }
}

/** Answers every live.command with `ok` (or the error) and collects the commands. */
function answerCommands(server: FakeSocket | undefined, error?: { code: string; message: string }) {
  const commands: protocol.DeviceCommand[] = []
  const seen = new Set<string>()
  return {
    commands,
    flush() {
      for (const m of server?.sent ?? []) {
        if (m.type !== 'live.command' || seen.has(m.id)) continue
        seen.add(m.id)
        commands.push((m.payload as { command: protocol.DeviceCommand }).command)
        act(() =>
          server?.reply(
            'live.result',
            { ok: !error, ...(error ? { error } : {}), command_id: newId(), duration_ms: 42 },
            m.id,
          ),
        )
      }
    },
  }
}

describe('controlling a device from the browser (T034)', () => {
  it('takes control, taps where clicked on the frame, and uses the buttons', async () => {
    const { server, device, requests, session } = await open()
    await userEvent.click(screen.getByRole('button', { name: 'Take control' }))
    expect(await screen.findByText('You control this device')).toBeDefined()
    expect(screen.getByTestId('auto-release').textContent).toMatch(/in (9:5\d|10:00) without input/)
    expect(requests.some((r) => r.method === 'POST' && r.url.pathname.endsWith('/control'))).toBe(
      true,
    )

    act(() => server?.binary(frame(device.id)))
    const canvas = screen.getByTestId('live-canvas')
    await waitFor(() => expect(canvas.dataset.frames).toBe('1'))
    const answers = answerCommands(server)
    // (26.3, 55) on a 360×800 frame of a 1080×2400 screen → (79, 165): the menu icon.
    fireEvent.pointerDown(canvas, { clientX: 26.3, clientY: 55, button: 0, pointerId: 1 })
    fireEvent.pointerUp(canvas, { clientX: 26.3, clientY: 55, button: 0, pointerId: 1 })
    await waitFor(() => {
      answers.flush()
      expect(answers.commands).toEqual([{ kind: 'tap', x: 79, y: 165 }])
    })
    const sent = server?.sent.find((m) => m.type === 'live.command')
    expect(sent?.payload).toMatchObject({ live_session_id: session()?.live_session_id })

    for (const name of ['Back', 'Home', 'Hide keyboard', 'Restart app']) {
      await userEvent.click(screen.getByRole('button', { name }))
    }
    await userEvent.type(screen.getByLabelText('Type text'), 'Nguyễn Văn A{Enter}')
    await userEvent.type(screen.getByLabelText('Secret'), 'test_password')
    await userEvent.click(screen.getByRole('button', { name: 'Type secret' }))
    await waitFor(() => {
      answers.flush()
      expect(answers.commands.slice(1)).toEqual([
        { kind: 'back' },
        { kind: 'home' },
        { kind: 'hide_keyboard' },
        { kind: 'restart_app' },
        { kind: 'type', text: 'Nguyễn Văn A' },
        { kind: 'type', secret: 'TEST_PASSWORD' },
      ])
    })
    expect(screen.getByLabelText<HTMLInputElement>('Type text').value).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Release' }))
    expect(await screen.findByRole('button', { name: 'Take control' })).toBeDefined()
  })

  it('shows why a command failed, and when control ended', async () => {
    const { server, device } = await open()
    await userEvent.click(screen.getByRole('button', { name: 'Take control' }))
    await screen.findByText('You control this device')
    const answers = answerCommands(server, { code: 'command_failed', message: 'u2 died' })
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => {
      answers.flush()
      expect(screen.getByRole('alert').textContent).toBe('u2 died')
    })
    const current = await waitFor(() => {
      const id = (
        server?.sent.find((m) => m.type === 'live.command')?.payload as {
          live_session_id: string
        }
      ).live_session_id
      expect(id).toBeDefined()
      return id
    })
    act(() => server?.reply('live.ended', { live_session_id: current, reason: 'idle_timeout' }))
    expect(await screen.findByText('Released after a while without input.')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
    expect(device.id).toBeDefined()
  })

  it('says the device is busy when taking it is refused', async () => {
    await open({
      taken: Response.json(
        {
          error: {
            code: 'device_busy',
            message: 'the device is busy',
            activity: { kind: 'live', by: { user_id: newId(), name: 'Lan' }, since },
          },
        },
        { status: 409 },
      ),
    })
    await userEvent.click(screen.getByRole('button', { name: 'Take control' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/busy/)
  })

  it('shows who controls the device, and no control to a viewer (FR-002a)', async () => {
    const held = data.device('Pixel 8', {
      kind: 'live',
      by: { user_id: newId(), name: 'Lan' },
      since,
    })
    await open({ device: held })
    expect(screen.getByText('Controlled by Lan')).toBeDefined()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Take control' }).disabled).toBe(
      true,
    )
    cleanup()
    resetFakes()
    await open({ role: 'viewer' })
    expect(screen.queryByRole('button', { name: 'Take control' })).toBeNull()
    expect(screen.getByText(/View only/)).toBeDefined()
  })

  it('does nothing on clicks while not in control', async () => {
    const { server, device } = await open()
    act(() => server?.binary(frame(device.id)))
    const canvas = screen.getByTestId('live-canvas')
    await waitFor(() => expect(canvas.dataset.frames).toBe('1'))
    fireEvent.pointerDown(canvas, { clientX: 20, clientY: 20, button: 0, pointerId: 1 })
    fireEvent.pointerUp(canvas, { clientX: 20, clientY: 20, button: 0, pointerId: 1 })
    expect(server?.sentTypes()).not.toContain('live.command')
  })
})
