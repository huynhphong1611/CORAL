import type { protocol } from '@coral/shared'
import type { ArtifactSink, ItemResult, StepFiles, StepRef } from '@coral/runner'
import type { AgentConnection } from './connection'

type UploadName = protocol.Payload<'artifact.request_upload'>['files'][number]['name']

const CONTENT_TYPES: Record<UploadName, string> = {
  'screenshot.png': 'image/png',
  'tree.json': 'application/json',
  'device.log': 'text/plain; charset=utf-8',
  'result.json': 'application/json',
}

/**
 * ArtifactSink of the agent (research R11): asks the server for presigned PUT URLs over the
 * WebSocket, then uploads straight to S3. Keys always come from the server (T062).
 */
export class UploadSink implements ArtifactSink {
  constructor(
    private readonly connection: Pick<AgentConnection, 'request'>,
    private readonly run: { runId: string; runItemId: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async upload(
    step: StepRef,
    files: { name: UploadName; body: Uint8Array | string }[],
  ): Promise<Map<UploadName, string>> {
    const reply = await this.connection.request('artifact.request_upload', {
      run_id: this.run.runId,
      run_item_id: this.run.runItemId,
      step_index: step.index,
      step_id: step.id,
      files: files.map((f) => ({
        name: f.name,
        content_type: CONTENT_TYPES[f.name],
        size_bytes: typeof f.body === 'string' ? Buffer.byteLength(f.body) : f.body.byteLength,
      })),
    })
    if (reply.type !== 'artifact.upload_url') {
      throw new Error(`upload refused: ${JSON.stringify(reply.payload)}`)
    }
    const keys = new Map<UploadName, string>()
    for (const target of reply.payload.uploads) {
      const file = files.find((f) => f.name === target.name)
      if (!file) continue
      const res = await this.fetchImpl(target.url, {
        method: 'PUT',
        headers: { 'content-type': CONTENT_TYPES[file.name] },
        body: file.body,
      })
      if (!res.ok) throw new Error(`upload of ${file.name} failed: HTTP ${res.status}`)
      keys.set(file.name, target.key)
    }
    return keys
  }

  async saveStep(_testCase: string, step: StepRef, files: StepFiles) {
    const list: { name: UploadName; body: Uint8Array | string }[] = []
    if (files.screenshot) list.push({ name: 'screenshot.png', body: files.screenshot })
    if (files.tree) list.push({ name: 'tree.json', body: JSON.stringify(files.tree) })
    if (files.log !== undefined) list.push({ name: 'device.log', body: files.log })
    if (list.length === 0) return {}
    const keys = await this.upload(step, list)
    const screenshot = keys.get('screenshot.png')
    const tree = keys.get('tree.json')
    const log = keys.get('device.log')
    return {
      ...(screenshot ? { screenshot } : {}),
      ...(tree ? { tree } : {}),
      ...(log ? { log } : {}),
    }
  }

  async saveResult(result: ItemResult): Promise<void> {
    await this.upload({ index: 0, id: 'result' }, [
      { name: 'result.json', body: JSON.stringify(result, null, 2) },
    ])
  }
}
