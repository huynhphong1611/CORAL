import { newId, protocol } from '@coral/shared'
import type { SocketLike } from '../api/ws'

/** In-memory WebSocket for tests: the test plays the server. */
export class FakeSocket implements SocketLike {
  static all: FakeSocket[] = []
  readyState = 0
  binaryType = 'blob'
  sent: { type: string; id: string; payload: unknown }[] = []
  private listeners: Record<string, ((event: never) => void)[]> = {}

  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }

  addEventListener(type: string, listener: (event: never) => void) {
    ;(this.listeners[type] ??= []).push(listener)
  }

  private emit(type: string, event: unknown) {
    for (const listener of this.listeners[type] ?? []) listener(event as never)
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as { type: string; id: string; payload: unknown })
  }

  close() {
    this.readyState = 3
    this.emit('close', {})
  }

  // --- server side

  open() {
    this.readyState = 1
    this.emit('open', {})
  }

  reply(type: protocol.UiMessageType, payload: unknown, re?: string) {
    this.emit('message', { data: JSON.stringify(protocol.envelope(type, payload, re)) })
  }

  ready() {
    const auth = this.sent.findLast((m) => m.type === 'ui.auth')
    this.reply('ui.ready', { user_id: newId(), tenant_id: newId(), role: 'owner' }, auth?.id)
  }

  binary(bytes: number[]) {
    this.emit('message', { data: new Uint8Array(bytes).buffer })
  }

  /** Types of the messages the browser sent, ui.auth left out. */
  sentTypes(): string[] {
    return this.sent.filter((m) => m.type !== 'ui.auth').map((m) => m.type)
  }
}
