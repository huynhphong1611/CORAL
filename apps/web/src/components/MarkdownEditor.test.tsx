import { EditorView } from '@codemirror/view'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MarkdownEditor } from './YamlEditor'

describe('MarkdownEditor', () => {
  it('edits Markdown and reports the new text', () => {
    const onChange = vi.fn()
    render(<MarkdownEditor value={'# Rules\n'} onChange={onChange} issues={[]} label="AGENTS.md" />)
    const view = EditorView.findFromDOM(screen.getByTestId('yaml-editor'))
    expect(view?.state.doc.toString()).toBe('# Rules\n')
    view?.dispatch({ changes: { from: view.state.doc.length, insert: 'Use Vietnamese.\n' } })
    expect(onChange).toHaveBeenLastCalledWith('# Rules\nUse Vietnamese.\n')
    expect(screen.getByLabelText('AGENTS.md')).toBeTruthy()
  })
})
