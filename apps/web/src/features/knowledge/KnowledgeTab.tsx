import {
  api,
  validateMcpSource,
  validateSkillRulesSource,
  validateSkillSource,
  type ValidationIssue,
} from '@coral/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import { ApiError } from '../../api/client'
import {
  knowledgeKeys,
  NEW_FILE_BASE,
  savedKnowledgeSchema,
  useAgentsMd,
  useMcp,
  useSkill,
  useSkills,
} from '../../api/knowledge'
import { useCoral, useRole } from '../../api/queries'
import { buttonClass, Card, errorMessage, inputClass, QueryState } from '../../components/ui'
import {
  MarkdownEditor,
  YamlEditor,
  type EditorIssue,
  type YamlEditorHandle,
} from '../../components/YamlEditor'
import { en } from '../../i18n/en'
import { CHECK_MS, useDebounced, type Problem } from '../editor/check'

const t = en.knowledge

type Section =
  { kind: 'agents' } | { kind: 'skill'; name: string } | { kind: 'new-skill' } | { kind: 'mcp' }

const toIssue =
  (severity: EditorIssue['severity']) =>
  (p: Problem): EditorIssue => ({
    severity,
    message: `${p.code}: ${p.message}`,
    line: p.line,
    column: p.column,
  })

interface Check {
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

/** Problems of a text, checked once it stopped changing for CHECK_MS (like the editor, US5). */
function useChecked(text: string, check: (text: string) => Check) {
  const settled = useDebounced(text, CHECK_MS)
  const { errors, warnings } = useMemo(() => check(settled), [settled, check])
  return { checking: settled !== text, problems: errors, warnings }
}

const NOTHING: Check = { errors: [], warnings: [] }

/**
 * The project's knowledge (US4, contracts/web-ui-phase3.md): AGENTS.md, skills with their
 * rules.yaml, and mcp.yaml — each checked as you type and saved as one commit, refusing to
 * overwrite someone else's save. Viewers read; mcp.yaml is changed by owners and admins only.
 */
export function KnowledgeTab({ projectId }: { projectId: string }) {
  const [section, setSection] = useState<Section>({ kind: 'agents' })
  const skills = useSkills(projectId)
  const { canWrite } = useRole()
  const item = (current: boolean) =>
    `block w-full rounded-md px-3 py-1.5 text-left text-sm ${
      current ? 'bg-slate-100 font-medium text-slate-900' : 'text-slate-600 hover:bg-slate-50'
    }`
  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <nav aria-label={t.label} className="w-full space-y-1 lg:w-56">
        <button
          type="button"
          className={item(section.kind === 'agents')}
          aria-current={section.kind === 'agents' ? 'page' : undefined}
          onClick={() => setSection({ kind: 'agents' })}
        >
          AGENTS.md
        </button>
        <h3 className="px-3 pt-3 text-xs font-medium uppercase tracking-wide text-slate-500">
          {t.skills}
        </h3>
        {skills.data?.map((skill) => {
          const current = section.kind === 'skill' && section.name === skill.name
          return (
            <button
              key={skill.name}
              type="button"
              className={`${item(current)} font-mono`}
              aria-current={current ? 'page' : undefined}
              title={skill.description}
              onClick={() => setSection({ kind: 'skill', name: skill.name })}
            >
              {skill.name}
            </button>
          )
        })}
        {skills.data?.length === 0 && <p className="px-3 text-xs text-slate-500">{t.noSkills}</p>}
        {canWrite && (
          <button
            type="button"
            className={item(section.kind === 'new-skill')}
            onClick={() => setSection({ kind: 'new-skill' })}
          >
            {t.newSkill}
          </button>
        )}
        <h3 className="px-3 pt-3 text-xs font-medium uppercase tracking-wide text-slate-500">
          {t.tools}
        </h3>
        <button
          type="button"
          className={`${item(section.kind === 'mcp')} font-mono`}
          aria-current={section.kind === 'mcp' ? 'page' : undefined}
          onClick={() => setSection({ kind: 'mcp' })}
        >
          mcp.yaml
        </button>
      </nav>
      <div className="min-w-0 flex-1">
        {section.kind === 'agents' && <AgentsMdSection projectId={projectId} />}
        {section.kind === 'mcp' && <McpSection projectId={projectId} />}
        {section.kind === 'skill' && (
          <SkillSection
            key={section.name}
            projectId={projectId}
            name={section.name}
            onSaved={(name) => setSection({ kind: 'skill', name })}
            onDeleted={() => setSection({ kind: 'agents' })}
          />
        )}
        {section.kind === 'new-skill' && (
          <SkillSection
            key="new"
            projectId={projectId}
            onSaved={(name) => setSection({ kind: 'skill', name })}
            onDeleted={() => setSection({ kind: 'agents' })}
          />
        )}
      </div>
    </div>
  )
}

/** Below an editor: checking / valid / problems with their line, then notices. */
function Status({
  checking,
  problems,
  warnings = [],
  notice,
  onReveal,
}: {
  checking: boolean
  problems: readonly Problem[]
  warnings?: readonly Problem[]
  notice: string | undefined
  onReveal: (problem: Problem) => void
}) {
  const list = (items: readonly Problem[], tone: 'error' | 'warning') => (
    <ul
      role={tone === 'error' ? 'alert' : undefined}
      aria-label={tone === 'error' ? 'Errors' : 'Warnings'}
      className={`space-y-0.5 text-xs ${tone === 'error' ? 'text-red-700' : 'text-amber-800'}`}
    >
      {items.map((p) => (
        <li key={`${p.path}-${p.code}-${p.line ?? ''}`}>
          {p.line !== undefined && (
            <button
              type="button"
              className="font-mono underline-offset-2 hover:underline"
              onClick={() => onReveal(p)}
            >
              {en.editor.issueAt(p.line, p.column ?? 1)}
            </button>
          )}
          {p.line !== undefined && ' · '}
          {p.code}: {p.message}
        </li>
      ))}
    </ul>
  )
  return (
    <div className="space-y-2 text-sm">
      <p className="text-xs">
        {checking ? (
          <span className="text-slate-500">{en.editor.checking}</span>
        ) : problems.length > 0 ? (
          <span className="font-medium text-red-700">{en.editor.problems(problems.length)}</span>
        ) : (
          <span className="text-emerald-700">{en.editor.valid}</span>
        )}
      </p>
      {!checking && problems.length > 0 && list(problems, 'error')}
      {!checking && warnings.length > 0 && list(warnings, 'warning')}
      {notice && (
        <p role="status" className="rounded-md bg-slate-100 px-3 py-2 text-slate-700">
          {notice}
        </p>
      )}
    </div>
  )
}

/** Someone else saved since this editor opened: keep the edits, offer their version. */
function Conflict({ onLoad }: { onLoad: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900"
    >
      <span>{en.editor.conflict}</span>
      <button
        type="button"
        className={buttonClass.secondary}
        onClick={() => window.confirm(en.editor.confirmLoadLatest) && onLoad()}
      >
        {en.editor.loadLatest}
      </button>
    </div>
  )
}

/** Saving a knowledge file: the new base, a conflict, the problems the server found. */
function useSave() {
  const [conflict, setConflict] = useState(false)
  const [notice, setNotice] = useState<string | undefined>()
  const [serverProblems, setServerProblems] = useState<{ key: string; problems: Problem[] }>()
  const [pending, setPending] = useState(false)
  async function run(
    key: string,
    save: () => Promise<{ head_commit: string }>,
    done: (head: string) => void,
  ) {
    setPending(true)
    setNotice(undefined)
    try {
      const saved = await save()
      setConflict(false)
      setNotice(t.saved)
      done(saved.head_commit)
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setConflict(true)
      else if (error instanceof ApiError && Array.isArray(error.details) && error.details.length) {
        setServerProblems({ key, problems: error.details })
      } else setNotice(errorMessage(error))
    } finally {
      setPending(false)
    }
  }
  return {
    conflict,
    setConflict,
    notice,
    setNotice,
    pending,
    run,
    fromServer: (key: string) => (serverProblems?.key === key ? serverProblems.problems : []),
  }
}

const checkNothing = () => NOTHING

function AgentsMdSection({ projectId }: { projectId: string }) {
  const file = useAgentsMd(projectId)
  return (
    <QueryState query={file} isEmpty={() => false}>
      {(loaded) => <AgentsMdEditor projectId={projectId} file={loaded} />}
    </QueryState>
  )
}

function AgentsMdEditor({ projectId, file }: { projectId: string; file: api.AgentsMd }) {
  const { client } = useCoral()
  const queryClient = useQueryClient()
  const { canWrite } = useRole()
  const editor = useRef<YamlEditorHandle>(null)
  const [base, setBase] = useState({ commit: file.head_commit, text: file.content })
  const [text, setText] = useState(file.content)
  const save = useSave()
  const { checking } = useChecked(text, checkNothing)
  const tooBig = new TextEncoder().encode(text).length > api.MAX_KNOWLEDGE_FILE_BYTES
  const problems: Problem[] = tooBig
    ? [{ path: '', code: 'too_large', message: t.tooLarge }]
    : save.fromServer(text)
  const dirty = text !== base.text
  const canSave = canWrite && dirty && !checking && problems.length === 0 && !save.pending

  async function loadLatest() {
    const latest = await client.get(`/projects/${projectId}/agents-md`, api.agentsMdSchema)
    queryClient.setQueryData(knowledgeKeys.agentsMd(projectId), latest)
    setBase({ commit: latest.head_commit, text: latest.content })
    setText(latest.content)
    save.setConflict(false)
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="font-medium">AGENTS.md</h2>
          <p className="text-sm text-slate-500">{t.agentsHint}</p>
        </div>
        {canWrite && (
          <button
            type="button"
            className={buttonClass.primary}
            disabled={!canSave}
            onClick={() =>
              void save.run(
                text,
                () =>
                  client.put(
                    `/projects/${projectId}/agents-md`,
                    { content: text, base_commit: base.commit },
                    savedKnowledgeSchema,
                  ),
                (head) => setBase({ commit: head, text }),
              )
            }
          >
            {save.pending ? en.editor.saving : en.editor.save}
          </button>
        )}
      </div>
      {save.conflict && <Conflict onLoad={() => void loadLatest()} />}
      {!canWrite && <p className="text-sm text-slate-500">{t.readOnly}</p>}
      <MarkdownEditor
        ref={editor}
        value={text}
        onChange={(next) => {
          setText(next)
          save.setNotice(undefined)
        }}
        issues={[]}
        readOnly={!canWrite}
        label="AGENTS.md"
      />
      <Status
        checking={checking}
        problems={problems}
        notice={save.notice}
        onReveal={(p) => editor.current?.reveal(p)}
      />
    </Card>
  )
}

function McpSection({ projectId }: { projectId: string }) {
  const file = useMcp(projectId)
  return (
    <QueryState query={file} isEmpty={() => false}>
      {(loaded) => <McpEditor projectId={projectId} file={loaded} />}
    </QueryState>
  )
}

/**
 * The server knows which local (stdio) servers the platform allows: it checks those on Save.
 * A credential typed in clear is a warning: saved, but flagged.
 */
function checkMcp(text: string): Check {
  if (text.trim() === '') return NOTHING
  const { errors, warnings } = validateMcpSource(text, 'mcp.yaml')
  return { errors: errors.filter((e) => e.code !== 'stdio_not_allowed'), warnings }
}

function McpEditor({ projectId, file }: { projectId: string; file: api.McpFile }) {
  const { client } = useCoral()
  const queryClient = useQueryClient()
  const { role } = useRole()
  const canEdit = role === 'owner' || role === 'admin'
  const editor = useRef<YamlEditorHandle>(null)
  const [base, setBase] = useState({ commit: file.head_commit, text: file.yaml })
  const [text, setText] = useState(file.yaml)
  const save = useSave()
  const checked = useChecked(text, checkMcp)
  const problems = [...checked.problems, ...save.fromServer(text)]
  const canSave =
    canEdit && text !== base.text && !checked.checking && problems.length === 0 && !save.pending

  async function loadLatest() {
    const latest = await client.get(`/projects/${projectId}/mcp`, api.mcpFileSchema)
    queryClient.setQueryData(knowledgeKeys.mcp(projectId), latest)
    setBase({ commit: latest.head_commit, text: latest.yaml })
    setText(latest.yaml)
    save.setConflict(false)
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="font-mono font-medium">mcp.yaml</h2>
          <p className="text-sm text-slate-500">{t.mcpHint}</p>
        </div>
        {canEdit && (
          <button
            type="button"
            className={buttonClass.primary}
            disabled={!canSave}
            onClick={() =>
              void save.run(
                text,
                () =>
                  client.put(
                    `/projects/${projectId}/mcp`,
                    { yaml: text, base_commit: base.commit },
                    savedKnowledgeSchema,
                  ),
                (head) => setBase({ commit: head, text }),
              )
            }
          >
            {save.pending ? en.editor.saving : en.editor.save}
          </button>
        )}
      </div>
      {save.conflict && <Conflict onLoad={() => void loadLatest()} />}
      {!canEdit && <p className="text-sm text-slate-500">{t.mcpReadOnly}</p>}
      <YamlEditor
        ref={editor}
        value={text}
        onChange={(next) => {
          setText(next)
          save.setNotice(undefined)
        }}
        issues={
          checked.checking
            ? []
            : [...problems.map(toIssue('error')), ...checked.warnings.map(toIssue('warning'))]
        }
        readOnly={!canEdit}
        label="mcp.yaml"
      />
      <Status
        checking={checked.checking}
        problems={problems}
        warnings={checked.warnings}
        notice={save.notice}
        onReveal={(p) => editor.current?.reveal(p)}
      />
    </Card>
  )
}

const SKILL_TEMPLATE = (name: string) => `---
name: ${name}
description: When the AI should use this skill
---
What to do, step by step.
`

function SkillSection({
  projectId,
  name,
  onSaved,
  onDeleted,
}: {
  projectId: string
  name?: string
  onSaved: (name: string) => void
  onDeleted: () => void
}) {
  const skill = useSkill(projectId, name)
  if (name === undefined) {
    return (
      <SkillEditor
        projectId={projectId}
        skill={{ name: '', skill_md: '', rules_yaml: null, head_commit: NEW_FILE_BASE }}
        onSaved={onSaved}
        onDeleted={onDeleted}
      />
    )
  }
  return (
    <QueryState query={skill} isEmpty={() => false}>
      {(loaded) => (
        <SkillEditor projectId={projectId} skill={loaded} onSaved={onSaved} onDeleted={onDeleted} />
      )}
    </QueryState>
  )
}

function SkillEditor({
  projectId,
  skill,
  onSaved,
  onDeleted,
}: {
  projectId: string
  skill: api.SkillDetail
  onSaved: (name: string) => void
  onDeleted: () => void
}) {
  const { client } = useCoral()
  const queryClient = useQueryClient()
  const { canWrite } = useRole()
  const isNew = skill.name === ''
  const skillEditor = useRef<YamlEditorHandle>(null)
  const rulesEditor = useRef<YamlEditorHandle>(null)
  const [name, setName] = useState(skill.name)
  const [base, setBase] = useState({
    commit: skill.head_commit,
    skill: skill.skill_md,
    rules: skill.rules_yaml ?? '',
  })
  const [skillMd, setSkillMd] = useState(skill.skill_md)
  const [rules, setRules] = useState(skill.rules_yaml ?? '')
  const save = useSave()
  const nameOk = api.skillNameSchema.safeParse(name).success
  const checkSkill = useMemo(
    () => (text: string) =>
      text === '' && isNew ? NOTHING : validateSkillSource(text, nameOk ? name : undefined),
    [isNew, name, nameOk],
  )
  const checkRules = useMemo(
    () => (text: string) => (text.trim() === '' ? NOTHING : validateSkillRulesSource(text)),
    [],
  )
  const skillChecked = useChecked(skillMd, checkSkill)
  const rulesChecked = useChecked(rules, checkRules)
  const key = `${skillMd}\u0000${rules}`
  const skillProblems = [
    ...skillChecked.problems,
    ...save.fromServer(key).filter((p) => !p.path.startsWith('rules')),
  ]
  const rulesProblems = rulesChecked.problems
  const checking = skillChecked.checking || rulesChecked.checking
  const dirty = isNew || skillMd !== base.skill || rules !== base.rules
  const canSave =
    canWrite &&
    dirty &&
    nameOk &&
    skillMd.trim() !== '' &&
    !checking &&
    skillProblems.length === 0 &&
    rulesProblems.length === 0 &&
    !save.pending

  async function submit() {
    await save.run(
      key,
      () =>
        client.put(
          `/projects/${projectId}/skills/${name}`,
          {
            skill_md: skillMd,
            ...(rules.trim() === '' ? {} : { rules_yaml: rules }),
            base_commit: base.commit,
          },
          savedKnowledgeSchema,
        ),
      (head) => {
        setBase({ commit: head, skill: skillMd, rules })
        void queryClient.invalidateQueries({ queryKey: knowledgeKeys.skills(projectId) })
        queryClient.setQueryData<api.SkillDetail>(knowledgeKeys.skill(projectId, name), {
          name,
          skill_md: skillMd,
          rules_yaml: rules.trim() === '' ? null : rules,
          head_commit: head,
        })
        if (isNew) onSaved(name)
      },
    )
  }

  async function remove() {
    if (!window.confirm(t.confirmDelete(name))) return
    try {
      await client.delete(`/projects/${projectId}/skills/${name}?base_commit=${base.commit}`)
      queryClient.removeQueries({ queryKey: knowledgeKeys.skill(projectId, name) })
      await queryClient.invalidateQueries({ queryKey: knowledgeKeys.skills(projectId) })
      onDeleted()
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) save.setConflict(true)
      else save.setNotice(errorMessage(error))
    }
  }

  async function loadLatest() {
    const latest = await client.get(`/projects/${projectId}/skills/${name}`, api.skillDetailSchema)
    queryClient.setQueryData(knowledgeKeys.skill(projectId, name), latest)
    setBase({ commit: latest.head_commit, skill: latest.skill_md, rules: latest.rules_yaml ?? '' })
    setSkillMd(latest.skill_md)
    setRules(latest.rules_yaml ?? '')
    save.setConflict(false)
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {isNew ? (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-slate-500">{t.skillName}</span>
            <input
              className={`${inputClass} font-mono`}
              value={name}
              placeholder="login-demo-account"
              onChange={(event) => {
                const next = event.target.value
                if (skillMd === '' || skillMd === SKILL_TEMPLATE(name)) {
                  setSkillMd(SKILL_TEMPLATE(next))
                }
                setName(next)
              }}
            />
          </label>
        ) : (
          <h2 className="font-mono font-medium">{skill.name}</h2>
        )}
        {canWrite && (
          <div className="flex gap-2">
            {!isNew && (
              <button type="button" className={buttonClass.secondary} onClick={() => void remove()}>
                {t.delete}
              </button>
            )}
            <button
              type="button"
              className={buttonClass.primary}
              disabled={!canSave}
              onClick={() => void submit()}
            >
              {save.pending ? en.editor.saving : en.editor.save}
            </button>
          </div>
        )}
      </div>
      {isNew && name !== '' && !nameOk && (
        <p role="alert" className="text-xs text-red-700">
          {t.badName}
        </p>
      )}
      {save.conflict && <Conflict onLoad={() => void loadLatest()} />}
      {!canWrite && <p className="text-sm text-slate-500">{t.readOnly}</p>}
      <h3 className="text-sm font-medium">SKILL.md</h3>
      <MarkdownEditor
        ref={skillEditor}
        value={skillMd}
        onChange={(next) => {
          setSkillMd(next)
          save.setNotice(undefined)
        }}
        issues={skillChecked.checking ? [] : skillProblems.map(toIssue('error'))}
        readOnly={!canWrite}
        label="SKILL.md"
      />
      <Status
        checking={skillChecked.checking}
        problems={skillProblems}
        notice={undefined}
        onReveal={(p) => skillEditor.current?.reveal(p)}
      />
      <h3 className="text-sm font-medium">
        rules.yaml <span className="font-normal text-slate-500">{t.rulesHint}</span>
      </h3>
      <YamlEditor
        ref={rulesEditor}
        value={rules}
        onChange={(next) => {
          setRules(next)
          save.setNotice(undefined)
        }}
        issues={rulesChecked.checking ? [] : rulesProblems.map(toIssue('error'))}
        readOnly={!canWrite}
        label="rules.yaml"
      />
      <Status
        checking={rulesChecked.checking}
        problems={rulesProblems}
        notice={save.notice}
        onReveal={(p) => rulesEditor.current?.reveal(p)}
      />
    </Card>
  )
}
