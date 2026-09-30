import type { protocol } from '@coral/shared'
import type { AgentGateway } from '../agents/gateway'

type AgentCommand = protocol.Payload<'device.command'>['command']
export type CommandResult = protocol.Payload<'device.command_result'>

/** Longest wait for an agent's answer to a command (a record step takes the longest). */
export const COMMAND_TIMEOUT_MS = 30_000

interface Pending {
  agentId: string
  resolve: (result: CommandResult) => void
  timer: NodeJS.Timeout
}

/**
 * `device.command` → `device.command_result` over the agent socket (contracts/agent-ws-phase2.md):
 * one request/answer channel shared by live control and the Recorder. An answer counts only from
 * the agent the command went to.
 */
export class AgentCommands {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly agents: Pick<AgentGateway, 'send' | 'on' | 'onAgentOffline'>) {
    agents.on('device.command_result', (ctx, message) => {
      const waiting = this.pending.get(message.payload.command_id)
      if (!waiting || waiting.agentId !== ctx.agent.id) return
      this.settle(message.payload.command_id, message.payload)
    })
    agents.onAgentOffline((agent) => {
      for (const [commandId, waiting] of this.pending) {
        if (waiting.agentId !== agent.id) continue
        this.settle(commandId, {
          command_id: commandId,
          ok: false,
          error: { code: 'device_offline', message: 'the agent disconnected' },
        })
      }
    })
  }

  /** Sends one command and resolves with the agent's answer (or a failure: offline, timeout). */
  send(
    agentId: string,
    input: { commandId: string; udid: string; command: AgentCommand },
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () =>
          this.settle(input.commandId, {
            command_id: input.commandId,
            ok: false,
            error: { code: 'timeout', message: `no answer from the device within ${timeoutMs} ms` },
          }),
        timeoutMs,
      )
      timer.unref()
      this.pending.set(input.commandId, { agentId, resolve, timer })
      const sent = this.agents.send(agentId, 'device.command', {
        command_id: input.commandId,
        udid: input.udid,
        command: input.command,
      })
      if (!sent) {
        this.settle(input.commandId, {
          command_id: input.commandId,
          ok: false,
          error: { code: 'device_offline', message: 'the agent is not connected' },
        })
      }
    })
  }

  private settle(commandId: string, result: CommandResult): void {
    const waiting = this.pending.get(commandId)
    if (!waiting) return
    this.pending.delete(commandId)
    clearTimeout(waiting.timer)
    waiting.resolve(result)
  }
}
