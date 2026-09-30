import { newId, protocol } from '@coral/shared'
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as data from '../testing/data'
import { renderApp, resetFakes } from '../testing/render-app'

afterEach(() => {
  cleanup()
  resetFakes()
  vi.restoreAllMocks()
})

/** Images drawn on the canvas, by size (each test frame has a distinct image length). */
let drawn: number[] = []
/** When set, decoding waits for this promise (a slow decoder). */
let gate: Promise<void> | undefined

beforeEach(() => {
  drawn = []
  gate = undefined
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
    await gate
    return { width: 576, height: 1280, size: blob.size, close: () => undefined }
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: (bitmap: { size: number }) => drawn.push(bitmap.size),
  } as unknown as CanvasRenderingContext2D)
})

const pixel = data.device('Pixel 8')

function frame(seq: number, deviceId = pixel.id) {
  return [
    ...protocol.encodeFrame(
      {
        type: 'stream.frame',
        device_id: deviceId,
        seq,
        ts: Date.now(),
        width: 576,
        height: 1280,
        device_width: 1080,
        device_height: 2400,
        rotation: 0,
        mime: 'image/jpeg',
      },
      new Uint8Array(100 + seq),
    ),
  ]
}

async function open() {
  const app = await renderApp(`/devices/${pixel.id}`, { routes: { 'GET /devices': [pixel] } })
  expect(await screen.findByRole('heading', { name: 'Pixel 8' })).toBeDefined()
  await waitFor(() => expect(app.server?.sentTypes()).toContain('stream.subscribe'))
  return app
}

describe('LiveView (T030)', () => {
  it('subscribes, paints frames at their size and shows the rate and screen size', async () => {
    const { server } = await open()
    const subscribe = server?.sent.find((m) => m.type === 'stream.subscribe')
    expect(subscribe?.payload).toEqual({ device_id: pixel.id })
    expect(screen.getByRole('status').textContent).toBe('Connecting to the device…')

    act(() => {
      server?.reply('stream.status', { device_id: pixel.id, state: 'live' })
      server?.binary(frame(0))
    })
    await waitFor(() => expect(drawn).toEqual([100]))
    const canvas = screen.getByTestId<HTMLCanvasElement>('live-canvas')
    expect([canvas.width, canvas.height]).toEqual([576, 1280])
    expect(screen.getByTestId('device-screen').textContent).toBe('1080 × 2400')
    expect(screen.getByTestId('live-state').textContent).toBe('live')
    expect(screen.getByTestId('live-fps').textContent).toBe('1 fps')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('paints only the newest frame when frames come faster than they decode', async () => {
    const { server } = await open()
    let release: () => void = () => undefined
    gate = new Promise((resolve) => (release = resolve))
    act(() => {
      server?.binary(frame(0))
      server?.binary(frame(1))
      server?.binary(frame(2))
      server?.binary(frame(3, newId()))
    })
    release()
    await waitFor(() => expect(drawn).toEqual([100, 102]))
  })

  it('covers the screen when the stream stalls or stops, and uncovers it when frames resume', async () => {
    const { server } = await open()
    act(() => server?.binary(frame(0)))
    await waitFor(() => expect(drawn).toHaveLength(1))
    act(() => server?.reply('stream.status', { device_id: pixel.id, state: 'stalled' }))
    expect(screen.getByRole('status').textContent).toBe('Connection lost — reconnecting')
    act(() => server?.reply('stream.status', { device_id: pixel.id, state: 'live' }))
    expect(screen.queryByRole('status')).toBeNull()
    act(() =>
      server?.reply('stream.status', {
        device_id: pixel.id,
        state: 'stopped',
        reason: 'agent offline',
      }),
    )
    expect(screen.getByRole('status').textContent).toBe('The device went offline')
  })

  it("shows the server's refusal", async () => {
    const { server } = await open()
    const subscribe = server?.sent.find((m) => m.type === 'stream.subscribe')
    act(() =>
      server?.reply(
        'error',
        { code: 'device_offline', message: 'the device is offline' },
        subscribe?.id,
      ),
    )
    expect(screen.getByRole('status').textContent).toBe('the device is offline')
  })

  it('unsubscribes when leaving the page', async () => {
    const { server, router } = await open()
    await act(() => router.navigate({ to: '/devices' }))
    await waitFor(() => expect(server?.sentTypes()).toContain('stream.unsubscribe'))
    expect(server?.sent.at(-1)?.payload).toEqual({ device_id: pixel.id })
  })
})
