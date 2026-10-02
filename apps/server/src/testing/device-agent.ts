import {
  LONG_PRESS_MS,
  RecorderError,
  SWIPE_MS,
  inspect,
  observe,
  prepare,
  record,
  type RecorderDeps,
} from '@coral/runner'
import { FakeClock, FakeDriver, sampleApp } from '@coral/runner/testing'
import { createRedactor, type protocol } from '@coral/shared'
import { fakeAgent } from './fake-agent'
import { emulator, type ReceivedMessage } from './ws-client'

type DeviceCommand = protocol.Payload<'device.command'>
type AgentCommand = DeviceCommand['command']
type Answer = { result?: Record<string, unknown>; error?: { code: string; message: string } }

/** Lets a test hold, fail or replace the answer to one command before the device runs it. */
export type Intercept = (command: AgentCommand) => Promise<Answer | undefined> | Answer | undefined

/**
 * An agent whose device is a FakeDriver (the sample app by default), for server tests of the
 * Explorer: it answers `device.command` with the runner's own `prepare`, `observe`, `record` and
 * the plain controls, one after the other, uploading snapshots to the presigned URLs — what the
 * real agent does on a phone (apps/agent/src/commands.ts).
 */
export async function deviceAgent(
  baseUrl: string,
  token: string,
  options: { udid?: string; driver?: FakeDriver; intercept?: Intercept } = {},
) {
  const driver =
    options.driver ?? new FakeDriver({ ...sampleApp(), renderScreens: true, showTyped: true })
  const agent = await fakeAgent(baseUrl, token, { devices: [emulator(options.udid)] })
  const commands: AgentCommand[] = []
  const secrets = new Set<string>()
  let intercept = options.intercept
  let queue: Promise<void> = Promise.resolve()

  const deps = (): RecorderDeps => ({
    driver,
    redactor: createRedactor(secrets),
    build: () => Promise.resolve('/tmp/coral-fake.apk'),
    put: async (url, body, contentType) => {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': contentType },
        body: typeof body === 'string' ? body : Buffer.from(body),
      })
      if (!res.ok) throw new Error(`snapshot upload failed: HTTP ${res.status}`)
    },
    clock: new FakeClock(),
  })

  async function perform(command: AgentCommand): Promise<Record<string, unknown> | undefined> {
    if ('redact' in command) for (const value of command.redact) secrets.add(value)
    switch (command.kind) {
      case 'prepare':
        return prepare(deps(), command)
      case 'record':
        if (command.action.kind === 'type') {
          for (const value of command.action.redact) secrets.add(value)
        }
        return record(deps(), command)
      case 'inspect':
        return inspect(deps(), { x: command.x, y: command.y }, undefined)
      case 'observe':
        return observe(deps(), command)
      case 'tap':
        return driver.tapAt({ x: command.x, y: command.y }).then(() => undefined)
      case 'long_press':
        return driver
          .longPressAt({ x: command.x, y: command.y }, command.ms ?? LONG_PRESS_MS)
          .then(() => undefined)
      case 'swipe':
        return driver.swipe(command.from, command.to, command.ms ?? SWIPE_MS).then(() => undefined)
      case 'type':
        return driver.type(command.text).then(() => undefined)
      case 'back':
        return driver.back().then(() => undefined)
      case 'home':
        return driver.home().then(() => undefined)
      case 'hide_keyboard':
        return driver.hideKeyboard().then(() => undefined)
      case 'restart_app':
        await driver.stopApp(command.package)
        await driver.launch(command.package)
        return undefined
    }
  }

  async function handle(message: ReceivedMessage): Promise<void> {
    const payload = message.payload as DeviceCommand
    commands.push(payload.command)
    let answer: Answer
    try {
      answer = (await intercept?.(payload.command)) ?? { result: await perform(payload.command) }
    } catch (error) {
      answer = {
        error: {
          code: error instanceof RecorderError ? error.code : 'command_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
    if (agent.client.ws.readyState !== agent.client.ws.OPEN) return
    agent.client.send(
      'device.command_result',
      {
        command_id: payload.command_id,
        ok: answer.error === undefined,
        ...(answer.error ? { error: answer.error } : {}),
        ...(answer.result !== undefined ? { result: answer.result } : {}),
      },
      message.id,
    )
  }

  agent.client.ws.on('message', () => {
    // Commands are taken from what the client recorded, in order, one at a time per device.
    for (;;) {
      const index = agent.client.received.findIndex((m) => m.type === 'device.command')
      if (index < 0) break
      const [message] = agent.client.received.splice(index, 1)
      if (message) queue = queue.then(() => handle(message))
    }
  })

  return {
    agent,
    driver,
    commands,
    /** Replaces the interceptor (undefined: every command runs on the device). */
    intercept(next: Intercept | undefined) {
      intercept = next
    },
    /** Waits for the commands received so far. */
    idle: () => queue,
    close: () => agent.close(),
  }
}

export type DeviceAgent = Awaited<ReturnType<typeof deviceAgent>>
