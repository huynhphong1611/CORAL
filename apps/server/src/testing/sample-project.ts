import { randomBytes } from 'node:crypto'
import { PLACE_ORDER, SAMPLE_APP } from '@coral/runner/testing'
import { api, newId } from '@coral/shared'
import { and, eq } from 'drizzle-orm'
import { devices } from '../db/schema'
import { deviceAgent, type DeviceAgent } from './device-agent'
import { multipart } from './multipart'
import type { RunServer } from './run-server'
import type { TestUser } from './test-server'

/**
 * A project of the sample app (My Demo App look-alike) with one build, whose popups.yaml puts
 * Place Order in never_tap — what the Explorer tests explore.
 */
export async function sampleProject(server: RunServer, user: TestUser) {
  const call = server.call
  const project = api.projectSchema.parse(
    (await call(user, { method: 'POST', url: '/projects', payload: { name: `p-${newId()}` } }))
      .body,
  )
  const app = api.appSchema.parse(
    (
      await call(user, {
        method: 'POST',
        url: `/projects/${project.id}/apps`,
        payload: { platform: 'android', package_or_bundle_id: SAMPLE_APP, name: 'My Demo App' },
      })
    ).body,
  )
  const build = api.buildSchema.parse(
    (
      await call(user, {
        method: 'POST',
        url: `/apps/${app.id}/builds`,
        ...multipart({ version: '1.0.0' }, { name: 'app.apk', data: randomBytes(2048) }),
      })
    ).body,
  )
  const popups = api.popupsFileSchema.parse(
    (await call(user, { method: 'GET', url: `/projects/${project.id}/popups` })).body,
  )
  const put = await call(user, {
    method: 'PUT',
    url: `/projects/${project.id}/popups`,
    payload: {
      yaml: popups.yaml.replace("never_tap: ['Mua',", `never_tap: ['${PLACE_ORDER}', 'Mua',`),
      base_commit: popups.head_commit,
    },
  })
  if (put.status !== 200) throw new Error(`popups.yaml not updated: ${put.status}`)
  return { project, app, build }
}

/** A new agent whose one device (`udid`) runs the sample app; returns it with the device id. */
export async function sampleDevice(
  server: RunServer,
  user: TestUser,
  udid: string,
): Promise<{ sample: DeviceAgent; deviceId: string }> {
  const agent = await server.newAgent(user, `agent-${newId()}`)
  const sample = await deviceAgent(server.url, agent.token, { udid })
  const [row] = await server.db
    .select()
    .from(devices)
    .where(and(eq(devices.agentId, agent.id), eq(devices.udid, udid)))
  if (!row) throw new Error('device not registered')
  return { sample, deviceId: row.id }
}
