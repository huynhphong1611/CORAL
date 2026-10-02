import type { api } from '@coral/shared'
import type { DeviceRow, OpenLease } from '../repos/agents'
import type { TenantRepos } from '../repos'

export const toDevice = (d: DeviceRow) =>
  ({
    id: d.id,
    agent_id: d.agentId,
    platform: 'android' as const,
    kind: d.kind,
    model: d.model,
    os_version: d.osVersion,
    api_level: d.apiLevel,
    udid: d.udid,
    status: d.status,
  }) satisfies api.Device

const RUN_HOLDER = /^run:([0-9a-f-]{36})$/
const EXPLORATION_HOLDER = /^exploration:([0-9a-f-]{36})$/

/**
 * What a device is busy with (data-model §2): offline from its status, otherwise from its open
 * lease — a run, an exploration, a person controlling it, or a recording — and idle without one.
 */
export function activityOf(device: DeviceRow, lease?: OpenLease): api.DeviceActivity {
  if (device.status === 'offline') return { kind: 'offline' }
  if (!lease) return { kind: 'idle' }
  const runId = RUN_HOLDER.exec(lease.holderRef)?.[1]
  const explorationId = EXPLORATION_HOLDER.exec(lease.holderRef)?.[1]
  return {
    kind: lease.kind,
    ...(lease.userId && lease.userName
      ? { by: { user_id: lease.userId, name: lease.userName } }
      : {}),
    ...(runId ? { run_id: runId } : {}),
    ...(explorationId ? { exploration_id: explorationId } : {}),
    since: lease.acquiredAt.toISOString(),
  }
}

/** `GET /devices` and `devices.updated` (contracts/rest-api-phase2.md, ui-ws.md). */
export async function deviceViews(repos: Pick<TenantRepos, 'agents'>): Promise<api.DeviceView[]> {
  const [devices, leases] = await Promise.all([
    repos.agents.listDevices(),
    repos.agents.openLeases(),
  ])
  const byDevice = new Map(leases.map((lease) => [lease.deviceId, lease]))
  return devices.map((device) => ({
    ...toDevice(device),
    activity: activityOf(device, byDevice.get(device.id)),
  }))
}
