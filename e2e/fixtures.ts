import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, openSync } from 'node:fs'
import { promisify } from 'node:util'
import { test as base, expect, type Page } from '@playwright/test'
import { E2E_SERVER_URL } from './env'

const run = promisify(execFile)

export interface Account {
  email: string
  password: string
}

/**
 * `CORAL_E2E_DEVICE=emulator` (T046, Device workflow): the device is the Android emulator next to
 * a real coral-agent, the build the real My Demo App (CORAL_TEST_APK) — not the drawn fake.
 */
export const ON_EMULATOR = process.env.CORAL_E2E_DEVICE === 'emulator'

export interface FakeDevice {
  udid: string
  deviceId: string
  agentId: string
}

export async function api<T>(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${E2E_SERVER_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path}: HTTP ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

export async function accessToken(account: Account): Promise<string> {
  const session = await api<{ access_token: string }>('/auth/login', {
    method: 'POST',
    body: account,
  })
  return session.access_token
}

/**
 * An owner in a brand-new tenant, created with the server's own db:seed — or, with `teamOf`, a
 * second person in that account's tenant with `role`.
 */
export async function seedAccount(teamOf?: {
  account: Account
  role: 'admin' | 'member' | 'viewer'
}): Promise<Account> {
  const account = {
    email: `e2e-${randomBytes(4).toString('hex')}@coral.test`,
    password: `e2e-${randomBytes(12).toString('hex')}`,
  }
  await run('pnpm', ['-s', '--filter', '@coral/server', 'db:seed'], {
    env: {
      ...process.env,
      CORAL_SEED_EMAIL: account.email,
      CORAL_SEED_PASSWORD: account.password,
      ...(teamOf ? { CORAL_SEED_TEAM_OF: teamOf.account.email, CORAL_SEED_ROLE: teamOf.role } : {}),
    },
  })
  return account
}

/** The name the server shows for a seeded account (its email's local part). */
export const nameOf = (account: Account) => account.email.split('@')[0] ?? account.email

/**
 * Worker fixtures: `account` is an owner in a brand-new tenant, `fakeDevice` a coral-agent
 * (scripts/dev-fake-device.ts) whose device is the drawn My Demo App look-alike, online for that
 * tenant.
 */
export const test = base.extend<object, { account: Account; fakeDevice: FakeDevice }>({
  account: [
    async ({}, use) => {
      await use(await seedAccount())
    },
    { scope: 'worker' },
  ],
  fakeDevice: [
    async ({ account }, use) => {
      const token = await accessToken(account)
      const agent = await api<{ id: string; token: string }>('/agents', {
        method: 'POST',
        token,
        body: { name: 'e2e fake device' },
      })
      let udid = `fake-${randomBytes(3).toString('hex')}`
      let child: ChildProcess
      if (ON_EMULATOR) {
        // A real coral-agent (adb + u2); its log is kept with the E2E results.
        mkdirSync('e2e-results', { recursive: true })
        const log = openSync('e2e-results/agent.log', 'a')
        child = spawn('node', ['--import', 'tsx', 'apps/agent/src/main.ts'], {
          env: {
            ...process.env,
            CORAL_SERVER_URL: E2E_SERVER_URL,
            CORAL_AGENT_TOKEN: agent.token,
            CORAL_LOG_LEVEL: 'debug',
          },
          stdio: ['ignore', log, log],
        })
      } else {
        child = spawn('node', ['--import', 'tsx', 'scripts/dev-fake-device.ts'], {
          env: {
            ...process.env,
            CORAL_SERVER_URL: E2E_SERVER_URL,
            CORAL_AGENT_TOKEN: agent.token,
            CORAL_FAKE_UDID: udid,
            CORAL_LOG_LEVEL: 'warn',
          },
          stdio: ['ignore', 'inherit', 'inherit'],
        })
      }
      let deviceId = ''
      await expect
        .poll(
          async () => {
            const devices = await api<{ id: string; udid: string; status: string }[]>('/devices', {
              token,
            })
            const device = devices.find(
              (d) => (ON_EMULATOR || d.udid === udid) && d.status !== 'offline',
            )
            deviceId = device?.id ?? ''
            if (device) udid = device.udid
            return deviceId
          },
          { timeout: ON_EMULATOR ? 60_000 : 20_000, message: 'device online' },
        )
        .not.toBe('')
      await use({ udid, deviceId, agentId: agent.id })
      child.kill('SIGTERM')
    },
    { scope: 'worker' },
  ],
})

export { expect }

/** Signs in through the UI. */
export async function signIn(page: Page, account: Account, path = '/'): Promise<void> {
  await page.goto(path)
  await page.getByLabel('Email').fill(account.email)
  await page.getByLabel('Password').fill(account.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
}
