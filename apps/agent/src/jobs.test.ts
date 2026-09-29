import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { protocol } from '@coral/shared'
import { FakeClock, FakeDriver, el, windows } from '@coral/runner/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JobManager, type RunnableDriver } from './jobs'

const APP = 'com.example.app'
const RUN = '0192f000-0000-7000-8000-000000000001'
const ITEM_1 = '0192f000-0000-7000-8000-000000000011'
const ITEM_2 = '0192f000-0000-7000-8000-000000000012'
const APK = Buffer.from('fake apk bytes')
const APK_SHA = createHash('sha256').update(APK).digest('hex')

const LOGIN = `schema: coral/testcase@1
id: login
intent: x
platforms: [android]
variables:
  user: \${secret:TEST_USER}
steps:
  - id: s1
    action: launch
    expect: { visible_text: 'Login' }
  - id: s2
    action: type
    target: [{ android_id: 'id/user' }]
    value: \${var:user}
  - id: s3
    action: tap
    target: [{ text: 'Login' }]
    expect: { visible_text: 'Products' }
`

const login = windows(
  APP,
  el({
    bounds: [0, 0, 1080, 2400],
    children: [
      el({
        platform_id: `${APP}:id/user`,
        class: 'android.widget.EditText',
        clickable: true,
        bounds: [100, 100, 800, 120],
      }),
      el({
        text: 'Login',
        class: 'android.widget.Button',
        clickable: true,
        bounds: [100, 300, 800, 120],
      }),
    ],
  }),
)
const home = windows(
  APP,
  el({
    bounds: [0, 0, 1080, 2400],
    children: [el({ text: 'Products', bounds: [0, 100, 1080, 100] })],
  }),
)

const assign = (items: string[] = [LOGIN]): protocol.Payload<'job.assign'> => ({
  run_id: RUN,
  device_udid: 'emulator-5554',
  build: { build_id: RUN, package: APP, download_url: 'http://s3.test/build.apk', sha256: APK_SHA },
  items: items.map((yaml, i) => ({
    run_item_id: i === 0 ? ITEM_1 : ITEM_2,
    test_case_id: RUN,
    commit: 'a1b2c3d',
    yaml,
    assets: [],
  })),
  popups_yaml: 'schema: coral/popups@1\n',
  secrets: { TEST_USER: 'bob@example.com' },
  limits: { run_timeout_ms: 1_800_000, stable_timeout_ms: 3000 },
})

let cacheDir = ''
beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'coral-agent-'))
})
afterAll(() => rm(cacheDir, { recursive: true, force: true }))

function setup(opts: { apk?: Buffer; onSend?: (type: string, manager: JobManager) => void } = {}) {
  const sent: { type: string; payload: Record<string, unknown>; re?: string }[] = []
  const uploads: { url: string; contentType: string; body: string }[] = []
  let downloads = 0
  const drivers: { driver: FakeDriver; opened: number; closed: number }[] = []
  const connection = {
    send(type: protocol.MessageType, payload: unknown, re?: string) {
      sent.push({ type, payload: payload as Record<string, unknown>, ...(re ? { re } : {}) })
      opts.onSend?.(type, manager)
      return 'id'
    },
    request(type: protocol.MessageType, payload: unknown) {
      const p = payload as protocol.Payload<'artifact.request_upload'>
      expect(type).toBe('artifact.request_upload')
      return Promise.resolve(
        protocol.envelope('artifact.upload_url', {
          uploads: p.files.map((f) => ({
            name: f.name,
            url: `http://s3.test/put/${p.step_index}-${p.step_id}/${f.name}`,
            key: `tenant/runs/${p.run_id}/${p.run_item_id}/${p.step_index}-${p.step_id}/${f.name}`,
            expires_at: new Date().toISOString(),
          })),
        }) as protocol.Message,
      )
    },
  }
  const fakeFetch = ((url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const body = init.body
      uploads.push({
        url,
        contentType: (init.headers as Record<string, string>)['content-type'] ?? '',
        body: typeof body === 'string' ? body : Buffer.from(body as Uint8Array).toString('latin1'),
      })
      return Promise.resolve(new Response(null, { status: 200 }))
    }
    downloads += 1
    return Promise.resolve(new Response(opts.apk ?? APK, { status: 200 }))
  }) as unknown as typeof fetch
  const manager = new JobManager({
    connection: connection as never,
    cacheDir,
    fetch: fakeFetch,
    clock: new FakeClock(),
    createDriver: () => {
      const driver = new FakeDriver({
        screens: { login: { frames: [login], taps: { Login: 'home' } }, home: { frames: [home] } },
        start: 'login',
      })
      const entry = { driver, opened: 0, closed: 0 }
      drivers.push(entry)
      return Promise.resolve(
        Object.assign(driver, {
          open: () => Promise.resolve(void (entry.opened += 1)),
          close: () => Promise.resolve(void (entry.closed += 1)),
        }) as unknown as RunnableDriver,
      )
    },
  })
  return { manager, sent, uploads, drivers, downloads: () => downloads }
}

const types = (sent: { type: string }[]) => sent.map((m) => m.type)

describe('JobManager', () => {
  it('acks, runs every item, streams results, uploads artifacts and reports job.done', async () => {
    const t = setup()
    t.manager.handle(protocol.envelope('job.assign', assign([LOGIN, LOGIN])))
    expect(t.manager.busy('emulator-5554')).toBe(true)
    await t.manager.drain()
    expect(t.manager.busy('emulator-5554')).toBe(false)

    expect(types(t.sent)).toEqual([
      'job.ack',
      'step.result',
      'step.result',
      'step.result',
      'item.result',
      'step.result',
      'step.result',
      'step.result',
      'item.result',
      'job.done',
    ])
    expect(t.sent.at(-1)?.payload).toMatchObject({
      status: 'passed',
      summary: { passed: 2, failed: 0, skipped: 0 },
    })
    expect(t.sent[4]?.payload).toMatchObject({ run_item_id: ITEM_1, status: 'passed' })
    expect(t.sent[8]?.payload).toMatchObject({ run_item_id: ITEM_2, status: 'passed' })
    expect(t.sent[1]?.payload).toMatchObject({
      run_id: RUN,
      run_item_id: ITEM_1,
      step_index: 0,
      artifacts: {
        screenshot: expect.stringContaining('/0-s1/screenshot.png') as unknown,
        tree: expect.stringContaining('tree.json') as unknown,
      },
    })

    const put = (suffix: string) => t.uploads.filter((u) => u.url.endsWith(suffix))
    expect(put('/0-s1/screenshot.png')[0]?.contentType).toBe('image/png')
    expect(put('/0-s1/tree.json')[0]?.contentType).toBe('application/json')
    expect(put('/0-result/result.json')).toHaveLength(2)
    expect(put('device.log')).toHaveLength(0)
    // Secrets never leave the agent unmasked.
    expect(JSON.stringify({ sent: t.sent, uploads: t.uploads })).not.toContain('bob@example.com')
    expect(t.drivers[0]?.driver.calls.find((c) => c.kind === 'type')).toEqual({
      kind: 'type',
      text: 'bob@example.com',
    })

    // Installed once, from the cache, with the build checksum.
    expect(t.drivers[0]?.driver.calls.filter((c) => c.kind === 'install')).toEqual([
      { kind: 'install', path: join(cacheDir, 'builds', `${APK_SHA}.apk`), sha256: APK_SHA },
    ])
    expect(t.drivers[0]).toMatchObject({ opened: 1, closed: 1 })
  })

  it('reports a failing item with its step and the device log', async () => {
    const t = setup()
    const failing = LOGIN.replace(
      "visible_text: 'Products'",
      "visible_text: 'Nowhere', timeout_ms: 500",
    )
    t.manager.handle(protocol.envelope('job.assign', assign([failing])))
    await t.manager.drain()
    expect(t.sent.find((m) => m.type === 'item.result')?.payload).toMatchObject({
      status: 'failed',
      failure_code: 'EXPECT_FAILED',
      failed_step_id: 's3',
    })
    expect(t.sent.at(-1)?.payload).toMatchObject({
      status: 'failed',
      failure_code: 'EXPECT_FAILED',
      summary: { passed: 0, failed: 1 },
    })
    expect(t.uploads.filter((u) => u.url.endsWith('/2-s3/device.log'))).toHaveLength(1)
  })

  it('downloads a build only once per sha256', async () => {
    const t = setup()
    t.manager.handle(protocol.envelope('job.assign', assign()))
    await t.manager.drain()
    expect(t.downloads()).toBe(0)
    expect(await readdir(join(cacheDir, 'builds'))).toEqual([`${APK_SHA}.apk`])
  })

  it('rejects a second job on a busy device', async () => {
    const t = setup()
    t.manager.handle(protocol.envelope('job.assign', assign()))
    const second = protocol.envelope('job.assign', {
      ...assign(),
      run_id: '0192f000-0000-7000-8000-000000000002',
    })
    t.manager.handle(second)
    expect(t.sent[1]).toEqual({
      type: 'job.reject',
      payload: { run_id: second.payload.run_id, reason: 'device busy' },
      re: second.id,
    })
    await t.manager.drain()
  })

  it('stops after the current action on job.cancel and reports cancelled', async () => {
    let cancelled = false
    const t = setup({
      onSend: (type, manager) => {
        if (type === 'step.result' && !cancelled) {
          cancelled = true
          manager.handle(protocol.envelope('job.cancel', { run_id: RUN, reason: 'user' }))
        }
      },
    })
    t.manager.handle(protocol.envelope('job.assign', assign([LOGIN, LOGIN])))
    await t.manager.drain()
    expect(t.sent.at(-1)).toMatchObject({
      type: 'job.done',
      payload: { status: 'cancelled', summary: { skipped: 1 } },
    })
    expect(t.sent.filter((m) => m.type === 'step.result')).toHaveLength(1)
    expect(t.drivers[0]?.closed).toBe(1)
  })

  it('ends with error when the popup rules of the run are not valid', async () => {
    const t = setup()
    t.manager.handle(
      protocol.envelope('job.assign', {
        ...assign(),
        popups_yaml: 'schema: nope',
      }),
    )
    await t.manager.drain()
    expect(t.sent.at(-1)).toMatchObject({
      type: 'job.done',
      payload: { status: 'error', failure_code: 'DRIVER_ERROR' },
    })
  })

  it('ends with error when the build checksum does not match', async () => {
    const t = setup({ apk: Buffer.from('tampered') })
    await rm(join(cacheDir, 'builds'), { recursive: true, force: true })
    t.manager.handle(protocol.envelope('job.assign', assign()))
    await t.manager.drain()
    expect(t.sent.at(-1)).toMatchObject({
      type: 'job.done',
      payload: { status: 'error', failure_code: 'DRIVER_ERROR' },
    })
    expect(t.drivers).toHaveLength(0)
  })
})
