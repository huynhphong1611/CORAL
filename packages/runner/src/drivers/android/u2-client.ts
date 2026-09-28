/** JSON-RPC 2.0 client of the on-device u2 server (contracts/android-u2.md). */

export const U2_CALL_TIMEOUT_MS = 10_000

export class U2RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'U2RpcError'
  }

  /** The instrumentation died; restarting the server once usually fixes it (u2 does the same). */
  get needsRestart(): boolean {
    return /UiAutomation not connected|DeadObjectException|DeadSystemRuntimeException/.test(
      `${this.message} ${typeof this.data === 'string' ? this.data : ''}`,
    )
  }
}

/** The HTTP request failed (server gone, port closed, timeout). */
export class U2TransportError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'U2TransportError'
  }
}

interface RpcResponse {
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

export class U2Client {
  private nextId = 1

  constructor(
    readonly baseUrl: string,
    private readonly options: { timeoutMs?: number; fetch?: typeof fetch } = {},
  ) {}

  private get fetch(): typeof fetch {
    return this.options.fetch ?? fetch
  }

  async ping(timeoutMs = 2000): Promise<boolean> {
    try {
      const response = await this.fetch(`${this.baseUrl}/ping`, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      return (await response.text()).trim() === 'pong'
    } catch {
      return false
    }
  }

  async call<T = unknown>(method: string, params: unknown[] = [], timeoutMs?: number): Promise<T> {
    const id = this.nextId++
    let body: RpcResponse
    try {
      const response = await this.fetch(`${this.baseUrl}/jsonrpc/0`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(timeoutMs ?? this.options.timeoutMs ?? U2_CALL_TIMEOUT_MS),
      })
      body = (await response.json()) as RpcResponse
    } catch (error) {
      throw new U2TransportError(
        `u2 ${method} failed: ${error instanceof Error ? error.message : String(error)}`,
        error,
      )
    }
    if (body.error) {
      throw new U2RpcError(
        `u2 ${method}: ${body.error.message ?? 'unknown error'}`,
        body.error.code,
        body.error.data,
      )
    }
    return body.result as T
  }
}
