import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { yaml } from '@codemirror/lang-yaml'
import { defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint'
import { Compartment, EditorState, type Text } from '@codemirror/state'
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { useEffect, useRef } from 'react'

/** A problem to mark in the text: 1-based line and column, like `validateTestCaseSource`. */
export interface EditorIssue {
  severity: 'error' | 'warning'
  message: string
  line?: number | undefined
  column?: number | undefined
}

const theme = EditorView.theme({
  '&': { fontSize: '13px', height: '100%', backgroundColor: 'white' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  '.cm-gutters': { backgroundColor: 'rgb(248 250 252)', borderRight: '1px solid rgb(226 232 240)' },
})

/** Where an issue sits in the document: from its column to the end of its line. */
export function issueRange(doc: Text, issue: EditorIssue): { from: number; to: number } {
  const line = doc.line(Math.min(Math.max(issue.line ?? 1, 1), doc.lines))
  const from = line.from + Math.min(Math.max((issue.column ?? 1) - 1, 0), line.length)
  const to = line.to > from ? line.to : Math.min(from + 1, doc.length)
  return { from, to }
}

/**
 * The YAML editor (US5, research R1): CodeMirror 6 with YAML highlighting, undo history and the
 * given problems marked in the gutter and under the text. The caller validates (so the same
 * result can lock Save); the editor only shows it.
 */
export function YamlEditor({
  value,
  onChange,
  issues,
  readOnly = false,
  label,
}: {
  value: string
  onChange: (value: string) => void
  issues: readonly EditorIssue[]
  readOnly?: boolean
  label: string
}) {
  const parent = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | undefined>(undefined)
  const changed = useRef(onChange)
  changed.current = onChange
  const editable = useRef(new Compartment())

  useEffect(() => {
    if (!parent.current) return undefined
    const created = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          indentOnInput(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          yaml(),
          syntaxHighlighting(defaultHighlightStyle),
          lintGutter(),
          theme,
          EditorView.contentAttributes.of({ 'aria-label': label }),
          editable.current.of(readOnlyExtensions(readOnly)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) changed.current(update.state.doc.toString())
          }),
        ],
      }),
    })
    view.current = created
    return () => {
      created.destroy()
      view.current = undefined
    }
    // Created once; value, issues and readOnly flow in through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A new text from outside (a reload): replace the document, not while it is the same.
  useEffect(() => {
    const current = view.current
    if (!current || current.state.doc.toString() === value) return
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value } })
  }, [value])

  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure(readOnlyExtensions(readOnly)),
    })
  }, [readOnly])

  useEffect(() => {
    const current = view.current
    if (!current) return
    const diagnostics: Diagnostic[] = issues.map((issue) => ({
      ...issueRange(current.state.doc, issue),
      severity: issue.severity,
      message: issue.message,
    }))
    current.dispatch(setDiagnostics(current.state, diagnostics))
  }, [issues])

  return (
    <div
      ref={parent}
      data-testid="yaml-editor"
      className="h-[32rem] overflow-hidden rounded-md border border-slate-300 focus-within:border-slate-500 focus-within:ring-2 focus-within:ring-slate-200"
    />
  )
}

const readOnlyExtensions = (readOnly: boolean) =>
  readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []
