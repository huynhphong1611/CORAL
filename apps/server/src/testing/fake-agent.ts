import type { protocol } from '@coral/shared'
import { connectAgent, emulator, hello } from './ws-client'

type Assign = protocol.Payload<'job.assign'>

/**
 * A scripted agent over the real WebSocket protocol, for server integration tests: says hello with
 * its devices, heartbeats, and exposes helpers to answer jobs step by step.
 */
export async function fakeAgent(
  baseUrl: string,
  token: string,
  options: { devices?: protocol.DeviceInfo[]; heartbeatMs?: number } = {},
) {
  const client = await connectAgent(baseUrl, token)
  if (options.heartbeatMs) client.heartbeat(options.heartbeatMs)
  const sent = client.send('agent.hello', hello(options.devices ?? [emulator()]))
  const welcome = await client.next('agent.welcome', sent.id)

  /** Waits for the next job.assign. */
  async function nextJob(timeoutMs = 10_000): Promise<{ id: string; payload: Assign }> {
    const message = await client.next('job.assign', undefined, timeoutMs)
    return { id: message.id, payload: message.payload as Assign }
  }

  function ack(job: { id: string; payload: Assign }) {
    client.send('job.ack', { run_id: job.payload.run_id }, job.id)
  }

  /** Requests presigned PUT URLs for one step and uploads the given files (like upload-sink). */
  async function upload(
    job: Assign,
    itemId: string,
    step: { index: number; id: string },
    files: Record<'screenshot.png' | 'tree.json' | 'device.log', Buffer | undefined>,
  ) {
    const entries = Object.entries(files).filter((e): e is [string, Buffer] => e[1] !== undefined)
    const contentType = (name: string) =>
      name.endsWith('.png')
        ? 'image/png'
        : name.endsWith('.json')
          ? 'application/json'
          : 'text/plain'
    const request = client.send('artifact.request_upload', {
      run_id: job.run_id,
      run_item_id: itemId,
      step_index: step.index,
      step_id: step.id,
      files: entries.map(([name, data]) => ({
        name: name as 'screenshot.png',
        content_type: contentType(name),
        size_bytes: data.length,
      })),
    })
    const answer = await client.next('artifact.upload_url', request.id)
    const { uploads } = answer.payload as protocol.Payload<'artifact.upload_url'>
    for (const target of uploads) {
      const data = entries.find(([name]) => name === target.name)?.[1]
      const res = await fetch(target.url, {
        method: 'PUT',
        headers: { 'content-type': contentType(target.name) },
        body: data,
      })
      if (!res.ok) throw new Error(`upload ${target.name} failed: ${res.status}`)
    }
    return uploads
  }

  /** Reports one passed (or failed) step. */
  function step(
    job: Assign,
    itemId: string,
    index: number,
    id: string,
    result: Partial<protocol.StepResult> = {},
  ) {
    client.send('step.result', {
      run_id: job.run_id,
      run_item_id: itemId,
      step_index: index,
      step_id: id,
      action: 'tap',
      status: 'passed',
      locator_used_index: 0,
      degraded: false,
      unstable: false,
      duration_ms: 120,
      popups_handled: [],
      artifacts: {},
      ...result,
    })
  }

  function item(job: Assign, itemId: string, status: 'passed' | 'failed' | 'error', extra = {}) {
    const now = new Date().toISOString()
    client.send('item.result', {
      run_id: job.run_id,
      run_item_id: itemId,
      status,
      started_at: now,
      finished_at: now,
      ...extra,
    })
  }

  function done(job: Assign, status: 'passed' | 'failed' | 'cancelled' | 'error') {
    client.send('job.done', {
      run_id: job.run_id,
      status,
      summary: { passed: status === 'passed' ? job.items.length : 0, failed: 0, skipped: 0 },
    })
  }

  return { client, welcome, nextJob, ack, upload, step, item, done, close: () => client.close() }
}
