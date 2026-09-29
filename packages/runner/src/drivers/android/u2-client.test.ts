import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Adb, type ExecFn } from './adb'
import { U2Client, U2RpcError } from './u2-client'
import { U2Server, U2StartError, U2_LAUNCH, type ServerProcess, type Spawner } from './u2-server'

/** In-process stand-in for the on-device u2 server. */
class FakeU2 {
  alive = false
  calls: { method: string; params: unknown[] }[] = []
  /** Raw request bodies as received on the wire. */
  bodies: Buffer[] = []
  failNext: string | undefined
  server: Server
  port = 0

  constructor() {
    this.server = createServer((req, res) => {
      if (!this.alive) {
        req.socket.destroy()
        return
      }
      if (req.url === '/ping') {
        res.end('pong')
        return
      }
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks)
        this.bodies.push(raw)
        const rpc = JSON.parse(raw.toString('utf8')) as {
          id: number
          method: string
          params: unknown[]
        }
        this.calls.push({ method: rpc.method, params: rpc.params })
        res.setHeader('content-type', 'application/json')
        if (this.failNext) {
          const message = this.failNext
          this.failNext = undefined
          res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32001, message } }))
          return
        }
        const result =
          rpc.method === 'deviceInfo'
            ? { displayWidth: 1080, displayHeight: 2400, sdkInt: 34 }
            : true
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
      })
    })
  }

  listen() {
    return new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as AddressInfo).port
        resolve()
      }),
    )
  }
}

let dir = ''
let jarPath = ''
let jarMd5 = ''
const u2 = new FakeU2()

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'coral-u2s-'))
  jarPath = join(dir, 'u2.jar')
  await writeFile(jarPath, 'jar bytes')
  jarMd5 = createHash('md5').update('jar bytes').digest('hex')
  await u2.listen()
})
afterAll(async () => {
  u2.server.close()
  await rm(dir, { recursive: true, force: true })
})
afterEach(() => {
  u2.alive = false
  u2.calls = []
  u2.bodies = []
})

function setup(opts: { remoteMd5?: string; startOutput?: string; exits?: boolean } = {}) {
  const adbCalls: string[] = []
  const exec: ExecFn = (_file, args) => {
    const key = args.join(' ')
    adbCalls.push(key)
    if (key.endsWith('md5sum /data/local/tmp/u2.jar'))
      return Promise.resolve(Buffer.from(`${opts.remoteMd5 ?? 'none'}  /data/local/tmp/u2.jar`))
    if (key.includes(' forward tcp:0 ')) return Promise.resolve(Buffer.from(`${u2.port}\n`))
    return Promise.resolve(Buffer.from(''))
  }
  const spawned: string[][] = []
  const spawner: Spawner = (file, args): ServerProcess => {
    spawned.push([file, ...args])
    if (!opts.startOutput) u2.alive = true
    return {
      output: () => opts.startOutput ?? '',
      exited: () => opts.exits ?? false,
      kill: () => (u2.alive = false),
    }
  }
  const server = new U2Server(new Adb('adb', exec).device('emu-1'), {
    jarPath,
    spawner,
    pollMs: 10,
    readyTimeoutMs: 500,
  })
  return { server, adbCalls, spawned }
}

describe('U2Client', () => {
  it('maps JSON-RPC errors and flags recoverable ones', async () => {
    u2.alive = true
    const client = new U2Client(`http://127.0.0.1:${u2.port}`)
    expect(await client.ping()).toBe(true)
    expect(await client.call('click', [1, 2])).toBe(true)
    u2.failNext = 'java.lang.IllegalStateException: UiAutomation not connected!'
    const error = await client.call('click', [1, 2]).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(U2RpcError)
    expect((error as U2RpcError).needsRestart).toBe(true)
    u2.failNext = 'uiautomator.UiObjectNotFoundException'
    expect(
      ((await client.call('setText', []).catch((e: unknown) => e)) as U2RpcError).needsRestart,
    ).toBe(false)
  })

  it('sends non-ASCII text as \\u escapes, so the server cannot garble it', async () => {
    u2.alive = true
    const client = new U2Client(`http://127.0.0.1:${u2.port}`)
    const text = 'Nguyễn Văn Ánh ệ ữ ỷ 😀'
    await client.call('setText', [{ focused: true }, text])
    const raw = u2.bodies.at(-1) ?? Buffer.alloc(0)
    expect([...raw].every((byte) => byte < 0x80)).toBe(true)
    expect(raw.toString('ascii')).toContain('Nguy\\u1ec5n')
    expect(u2.calls.at(-1)?.params[1]).toBe(text)
  })
})

describe('U2Server', () => {
  it('pushes the jar when the md5 differs, launches app_process and waits until ready', async () => {
    const { server, adbCalls, spawned } = setup()
    expect(await server.call('deviceInfo')).toMatchObject({ displayWidth: 1080 })
    expect(adbCalls).toContain(`-s emu-1 push ${jarPath} /data/local/tmp/u2.jar`)
    expect(adbCalls).toContain('-s emu-1 forward tcp:0 tcp:9008')
    expect(spawned).toEqual([['adb', '-s', 'emu-1', 'shell', U2_LAUNCH]])
  })

  it('skips the push when the jar is already there and reuses a running server', async () => {
    const { server, adbCalls, spawned } = setup({ remoteMd5: jarMd5 })
    u2.alive = true
    await server.call('deviceInfo')
    expect(adbCalls.some((c) => c.includes(' push '))).toBe(false)
    expect(spawned).toEqual([])
  })

  it('restarts once when the instrumentation died', async () => {
    const { server, spawned } = setup({ remoteMd5: jarMd5 })
    await server.start()
    u2.failNext = 'android.os.DeadObjectException'
    expect(await server.call('click', [5, 5])).toBe(true)
    expect(spawned).toHaveLength(2)
    expect(u2.calls.map((c) => c.method)).toEqual(['click', 'click'])
  })

  it('explains "already registered" (another UiAutomation client)', async () => {
    const { server } = setup({
      startOutput: 'java.lang.IllegalStateException: UiAutomationService … already registered!',
    })
    await expect(server.start()).rejects.toThrow(U2StartError)
    await expect(server.start()).rejects.toThrow(/another UiAutomation client/)
  })

  it('reports a server that quits or never answers', async () => {
    await expect(
      setup({ startOutput: 'Exception in thread main', exits: true }).server.start(),
    ).rejects.toThrow('exited during start')
    await expect(setup({ startOutput: 'starting…' }).server.start()).rejects.toThrow(
      'did not become ready',
    )
  })
})
