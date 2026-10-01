import type { api } from '@coral/shared'
import { forEachDiagnostic } from '@codemirror/lint'
import { EditorView } from '@codemirror/view'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NEW_FILE_BASE } from '../../api/knowledge'
import * as data from '../../testing/data'
import { renderApp, resetFakes, type FakeRequest } from '../../testing/render-app'

// US4 (T046): the Knowledge tab — AGENTS.md, skills (SKILL.md + rules.yaml) and mcp.yaml checked
// as you type with the line of each problem, saved as commits against the base they were opened
// at, a conflict keeping the edits, skills created and deleted, mcp.yaml for owners and admins.

afterEach(() => {
  cleanup()
  resetFakes()
  vi.restoreAllMocks()
})

beforeEach(() => {
  // jsdom has no layout: CodeMirror measures ranges.
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null })
  Range.prototype.getBoundingClientRect = () => new DOMRect()
})

const shop = data.project('Shop')
const HEAD = 'a'.repeat(40)
const NEXT = 'b'.repeat(40)
const LATER = 'c'.repeat(40)
const base = `/projects/${shop.id}`

const SKILL = `---
name: login-demo-account
description: When the AI should use this skill
---
What to do, step by step.
`
const RULES = `schema: coral/skill-rules@1
test_data:
  username: '\${secret:TEST_USER}'
`

interface State {
  agents: api.AgentsMd
  skills: api.SkillDetail[]
  mcp: api.McpFile
}

async function open(
  opts: {
    role?: string
    state?: Partial<State>
    routes?: Record<string, (request: FakeRequest) => Response | object>
  } = {},
) {
  const state: State = {
    agents: { content: '# Shop\n', head_commit: HEAD },
    skills: [],
    mcp: { yaml: '', head_commit: HEAD },
    ...opts.state,
  }
  const summary = (s: api.SkillDetail): api.SkillSummary => ({
    name: s.name,
    description: 'When the AI should use this skill',
    has_rules: s.rules_yaml !== null,
  })
  const app = await renderApp(`${base}?tab=knowledge`, {
    ...(opts.role ? { role: opts.role } : {}),
    routes: {
      'GET /projects': [shop],
      [`GET ${base}/agents-md`]: () => state.agents,
      [`PUT ${base}/agents-md`]: (request) => {
        const body = request.body as { content: string }
        state.agents = { content: body.content, head_commit: NEXT }
        return { head_commit: NEXT }
      },
      [`GET ${base}/skills`]: () => state.skills.map(summary),
      [`GET ${base}/skills/login-demo-account`]: () =>
        state.skills.find((s) => s.name === 'login-demo-account') ??
        Response.json({ error: { code: 'not_found', message: 'no' } }, { status: 404 }),
      [`PUT ${base}/skills/login-demo-account`]: (request) => {
        const body = request.body as api.UpdateSkill
        state.skills = [
          {
            name: 'login-demo-account',
            skill_md: body.skill_md,
            rules_yaml: body.rules_yaml ?? null,
            head_commit: NEXT,
          },
        ]
        return { head_commit: NEXT }
      },
      [`DELETE ${base}/skills/login-demo-account`]: () => {
        state.skills = []
        return new Response(null, { status: 204 })
      },
      [`GET ${base}/mcp`]: () => state.mcp,
      ...opts.routes,
    },
  })
  await screen.findByRole('navigation', { name: 'Knowledge files' })
  return { ...app, state }
}

const view = (label: string) => {
  const found = EditorView.findFromDOM(screen.getByLabelText(label))
  if (!found) throw new Error(`no editor ${label}`)
  return found
}
const edit = (label: string, text: string) =>
  act(() => {
    const v = view(label)
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } })
  })
const errorLines = (label: string) => {
  const v = view(label)
  const lines: number[] = []
  forEachDiagnostic(v.state, (d, from) => {
    if (d.severity === 'error') lines.push(v.state.doc.lineAt(from).number)
  })
  return lines
}
const saveButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Save' })
const putsTo = (requests: FakeRequest[], path: string) =>
  requests.filter((r) => r.method === 'PUT' && r.url.pathname === `/api${base}${path}`)

describe('Knowledge tab (T046)', () => {
  it('saves AGENTS.md as a commit, then on its new head; refuses a file over 64 KB', async () => {
    const { requests } = await open()
    await screen.findByLabelText('AGENTS.md')
    expect(view('AGENTS.md').state.doc.toString()).toBe('# Shop\n')
    expect(saveButton().disabled).toBe(true)

    edit('AGENTS.md', '# Shop\nWrite intents in English.\n')
    await waitFor(() => expect(saveButton().disabled).toBe(false))
    await userEvent.click(saveButton())
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Saved'))
    expect(putsTo(requests, '/agents-md').map((r) => r.body)).toEqual([
      { content: '# Shop\nWrite intents in English.\n', base_commit: HEAD },
    ])

    edit('AGENTS.md', 'v2\n')
    await waitFor(() => expect(saveButton().disabled).toBe(false))
    await userEvent.click(saveButton())
    await waitFor(() => expect(putsTo(requests, '/agents-md')).toHaveLength(2))
    expect(putsTo(requests, '/agents-md')[1]?.body).toEqual({ content: 'v2\n', base_commit: NEXT })

    edit('AGENTS.md', 'x'.repeat(64 * 1024 + 1))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Too large'))
    expect(saveButton().disabled).toBe(true)
  })

  it('on a conflict keeps the edits and offers the latest version', async () => {
    let conflict = true
    const { state } = await open({
      routes: {
        [`PUT ${base}/agents-md`]: () => {
          if (!conflict) return { head_commit: LATER }
          state.agents = { content: '# Shop, theirs\n', head_commit: NEXT }
          return Response.json(
            { error: { code: 'conflict', message: 'AGENTS.md changed since base_commit' } },
            { status: 409 },
          )
        },
      },
    })
    await screen.findByLabelText('AGENTS.md')
    edit('AGENTS.md', '# Shop, mine\n')
    await waitFor(() => expect(saveButton().disabled).toBe(false))
    await userEvent.click(saveButton())
    expect(await screen.findByText(/^Changed by someone else/)).toBeDefined()
    expect(view('AGENTS.md').state.doc.toString()).toBe('# Shop, mine\n')

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await userEvent.click(screen.getByRole('button', { name: 'Load latest version' }))
    await waitFor(() => expect(view('AGENTS.md').state.doc.toString()).toBe('# Shop, theirs\n'))
    expect(screen.queryByText(/^Changed by someone else/)).toBeNull()
    conflict = false
  })

  it('creates a skill with its rules, checked as you type, then deletes it', async () => {
    const { requests } = await open()
    const nav = screen.getByRole('navigation', { name: 'Knowledge files' })
    expect(await within(nav).findByText('No skill yet.')).toBeDefined()

    await userEvent.click(within(nav).getByRole('button', { name: '+ New skill' }))
    const name = screen.getByRole('textbox', { name: 'Name' })
    await userEvent.type(name, 'Login')
    expect(screen.getByRole('alert').textContent).toContain('Lowercase letters')
    await userEvent.clear(name)
    await userEvent.type(name, 'login-demo-account')
    expect(screen.queryByText(/Lowercase letters/)).toBeNull()
    // The template follows the name.
    expect(view('SKILL.md').state.doc.toString()).toBe(SKILL)

    // The frontmatter names another skill: line 2.
    edit('SKILL.md', SKILL.replace('name: login-demo-account', 'name: other'))
    await waitFor(() => expect(errorLines('SKILL.md')).toEqual([2]))
    expect(saveButton().disabled).toBe(true)
    edit('SKILL.md', SKILL)

    // rules.yaml with a key it does not know.
    edit('rules.yaml', RULES.replace('test_data', 'test_date'))
    await waitFor(() => expect(errorLines('rules.yaml').length).toBeGreaterThan(0))
    expect(saveButton().disabled).toBe(true)
    edit('rules.yaml', RULES)
    await waitFor(() => expect(saveButton().disabled).toBe(false))
    await userEvent.click(saveButton())

    // Saved: the skill is listed and opened.
    expect(await within(nav).findByRole('button', { name: 'login-demo-account' })).toBeDefined()
    expect(await screen.findByRole('heading', { name: 'login-demo-account' })).toBeDefined()
    expect(screen.getByRole('status').textContent).toContain('Saved')
    expect(putsTo(requests, '/skills/login-demo-account').map((r) => r.body)).toEqual([
      { skill_md: SKILL, rules_yaml: RULES, base_commit: NEW_FILE_BASE },
    ])

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await within(nav).findByText('No skill yet.')).toBeDefined()
    const removed = requests.find((r) => r.method === 'DELETE')
    expect(removed?.url.searchParams.get('base_commit')).toBe(NEXT)
    expect(await screen.findByLabelText('AGENTS.md')).toBeDefined()
  })

  it('saves an existing skill without rules.yaml, which removes it', async () => {
    const { requests } = await open({
      state: {
        skills: [
          { name: 'login-demo-account', skill_md: SKILL, rules_yaml: RULES, head_commit: HEAD },
        ],
      },
    })
    await userEvent.click(await screen.findByRole('button', { name: 'login-demo-account' }))
    await screen.findByLabelText('rules.yaml')
    expect(view('rules.yaml').state.doc.toString()).toBe(RULES)
    edit('rules.yaml', '')
    await waitFor(() => expect(saveButton().disabled).toBe(false))
    await userEvent.click(saveButton())
    await waitFor(() => expect(putsTo(requests, '/skills/login-demo-account')).toHaveLength(1))
    expect(putsTo(requests, '/skills/login-demo-account')[0]?.body).toEqual({
      skill_md: SKILL,
      base_commit: HEAD,
    })
  })

  it('lets an owner edit mcp.yaml: a clear token warned, what the server refuses at its line', async () => {
    const yaml = `schema: coral/mcp@1
servers:
  otp:
    url: https://otp.test.example.com/mcp
    headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789' }
    tools: { get_otp: {} }
  browser:
    command: playwright-mcp
    tools: { browser_snapshot: {} }
`
    await open({
      routes: {
        [`PUT ${base}/mcp`]: () =>
          Response.json(
            {
              error: {
                code: 'validation_failed',
                message: 'mcp.yaml is not valid',
                details: [
                  {
                    path: 'servers.browser.command',
                    code: 'stdio_not_allowed',
                    message: 'local MCP server "browser" is not on the platform\'s allowlist',
                    line: 8,
                    column: 14,
                  },
                ],
              },
            },
            { status: 400 },
          ),
      },
    })
    await userEvent.click(screen.getByRole('button', { name: 'mcp.yaml' }))
    await screen.findByLabelText('mcp.yaml')
    edit('mcp.yaml', yaml)
    const warnings = await screen.findByRole('list', { name: 'Warnings' })
    expect(warnings.textContent).toContain('inline_credential')
    await waitFor(() => expect(saveButton().disabled).toBe(false))

    await userEvent.click(saveButton())
    await waitFor(() => expect(errorLines('mcp.yaml')).toEqual([8]))
    expect(screen.getByRole('alert').textContent).toContain('stdio_not_allowed')
    expect(saveButton().disabled).toBe(true)
    edit('mcp.yaml', yaml.replaceAll('browser', 'remote'))
    await waitFor(() => expect(errorLines('mcp.yaml')).toEqual([]))
  })

  it('shows mcp.yaml read only to a member, and everything read only to a viewer', async () => {
    await open({
      role: 'member',
      state: { mcp: { yaml: 'schema: coral/mcp@1\n', head_commit: HEAD } },
    })
    await userEvent.click(screen.getByRole('button', { name: 'mcp.yaml' }))
    expect(await screen.findByText(/only an owner or admin/)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    cleanup()
    resetFakes()

    await open({ role: 'viewer' })
    await screen.findByLabelText('AGENTS.md')
    expect(screen.getByText(/viewers cannot change/)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: '+ New skill' })).toBeNull()
  })
})
