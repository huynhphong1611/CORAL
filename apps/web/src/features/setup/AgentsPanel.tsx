import { api } from '@coral/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { keys, useAgents, useCoral, useRole } from '../../api/queries'
import {
  Badge,
  buttonClass,
  Card,
  errorMessage,
  formatTime,
  inputClass,
  QueryState,
  Table,
  Td,
  Th,
} from '../../components/ui'
import { en } from '../../i18n/en'

const STATUS_TONES = { online: 'green', offline: 'slate', revoked: 'red' } as const

/**
 * The tenant's agents (US7, FR-020): writers create one and see its token once, with Copy, then
 * run coral-agent with it; revoking disconnects the agent and kills its token.
 */
export function AgentsPanel() {
  const agents = useAgents()
  const { canWrite } = useRole()
  const [adding, setAdding] = useState(false)
  return (
    <section className="mt-8 space-y-3" aria-label={en.agents.title}>
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{en.agents.title}</h2>
        {canWrite && !adding && (
          <button type="button" className={buttonClass.primary} onClick={() => setAdding(true)}>
            {en.agents.add}
          </button>
        )}
      </div>
      {adding && <AddAgent onDone={() => setAdding(false)} />}
      <QueryState query={agents} empty={en.agents.empty}>
        {(list) => (
          <Table label={en.agents.title}>
            <thead>
              <tr>
                <Th>{en.agents.name}</Th>
                <Th>{en.agents.status}</Th>
                <Th>{en.agents.host}</Th>
                <Th>{en.agents.lastSeen}</Th>
                {canWrite && <Th className="w-24" />}
              </tr>
            </thead>
            <tbody>
              {list.map((agent) => (
                <AgentRow key={agent.id} agent={agent} canWrite={canWrite} />
              ))}
            </tbody>
          </Table>
        )}
      </QueryState>
    </section>
  )
}

function AgentRow({ agent, canWrite }: { agent: api.Agent; canWrite: boolean }) {
  const { client } = useCoral()
  const queryClient = useQueryClient()
  const revoke = useMutation({
    mutationFn: () => client.post(`/agents/${agent.id}/revoke`, {}),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.agents })
      void queryClient.invalidateQueries({ queryKey: keys.devices })
    },
  })
  return (
    <tr data-agent-id={agent.id} className="hover:bg-slate-50">
      <Td className="font-medium text-slate-900">{agent.name}</Td>
      <Td>
        <Badge tone={STATUS_TONES[agent.status]}>{agent.status}</Badge>
      </Td>
      <Td className="text-slate-600">
        {[agent.os, agent.version && `coral-agent ${agent.version}`].filter(Boolean).join(' · ') ||
          '—'}
      </Td>
      <Td className="text-slate-500">{formatTime(agent.last_seen_at)}</Td>
      {canWrite && (
        <Td>
          {agent.status !== 'revoked' && (
            <button
              type="button"
              className={buttonClass.secondary}
              aria-label={en.agents.revoke(agent.name)}
              disabled={revoke.isPending}
              onClick={() => window.confirm(en.agents.confirmRevoke(agent.name)) && revoke.mutate()}
            >
              {en.agents.revokeLabel}
            </button>
          )}
        </Td>
      )}
    </tr>
  )
}

/** Name → token, shown once with Copy; Done forgets it (it is never shown again). */
function AddAgent({ onDone }: { onDone: () => void }) {
  const { client } = useCoral()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [copied, setCopied] = useState(false)
  const create = useMutation({
    mutationFn: (agentName: string) =>
      client.post('/agents', { name: agentName }, api.createdAgentSchema),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.agents }),
  })
  const created = create.data

  function submit(event: FormEvent) {
    event.preventDefault()
    if (name.trim()) create.mutate(name.trim())
  }

  if (created) {
    return (
      <Card className="space-y-3 border-amber-300 bg-amber-50 p-4 text-sm">
        <h3 className="font-medium">{en.agents.tokenTitle(created.name)}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <input
            readOnly
            aria-label={en.agents.tokenTitle(created.name)}
            value={created.token}
            onFocus={(e) => e.target.select()}
            className={`${inputClass} min-w-0 flex-1 font-mono text-xs`}
          />
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() =>
              void navigator.clipboard?.writeText(created.token).then(() => setCopied(true))
            }
          >
            {copied ? en.agents.copied : en.agents.copy}
          </button>
        </div>
        <p role="alert" className="text-amber-900">
          {en.agents.tokenWarning}
        </p>
        <button type="button" className={buttonClass.primary} onClick={onDone}>
          {en.agents.done}
        </button>
      </Card>
    )
  }

  return (
    <Card className="p-4">
      <form
        onSubmit={submit}
        className="flex flex-wrap items-end gap-3 text-sm"
        aria-label={en.agents.add}
      >
        <label className="space-y-1">
          <span className="block font-medium">{en.agents.name}</span>
          <input
            className={inputClass}
            value={name}
            required
            maxLength={100}
            placeholder={en.agents.namePlaceholder}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button type="submit" className={buttonClass.primary} disabled={create.isPending}>
          {create.isPending ? en.agents.creating : en.agents.create}
        </button>
        <button type="button" className={buttonClass.link} onClick={onDone}>
          {en.common.cancel}
        </button>
        {create.isError && (
          <p role="alert" className="w-full text-red-700">
            {errorMessage(create.error)}
          </p>
        )}
      </form>
    </Card>
  )
}
