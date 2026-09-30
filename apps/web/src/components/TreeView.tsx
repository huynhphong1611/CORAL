import type { ElementNode } from '@coral/shared'
import { en } from '../i18n/en'

const shortClass = (name: string) => name.slice(name.lastIndexOf('.') + 1)
/** `com.app:id/login_button` → `login_button`. */
function shortId(id: string): string {
  const at = id.indexOf(':id/')
  return at >= 0 ? id.slice(at + 4) : id
}

/** One element: class, resource id, text/desc, bounds; windows and their first level open. */
function Node({ node, depth }: { node: ElementNode; depth: number }) {
  const label = node.text || node.desc
  const summary = (
    <span className={node.visible ? '' : 'text-slate-400'}>
      <span className="text-slate-900">{shortClass(node.class) || node.package_or_bundle}</span>
      {node.platform_id && <span className="text-sky-700"> #{shortId(node.platform_id)}</span>}
      {label && <span className="text-emerald-700"> “{label}”</span>}
      {node.clickable && <span className="text-amber-700"> clickable</span>}
      <span className="text-slate-400">
        {' '}
        [{node.bounds.x},{node.bounds.y} {node.bounds.w}×{node.bounds.h}]
      </span>
    </span>
  )
  if (node.children.length === 0) return <li className="py-0.5 pl-4">{summary}</li>
  return (
    <li className="py-0.5">
      <details open={depth < 2}>
        <summary className="cursor-pointer">{summary}</summary>
        <ul className="ml-3 border-l border-slate-200 pl-1">
          {node.children.map((child) => (
            <Node key={child.ref} node={child} depth={depth + 1} />
          ))}
        </ul>
      </details>
    </li>
  )
}

/** A step's `tree.json` as a collapsible tree (FR-003). */
export function TreeView({ windows }: { windows: readonly ElementNode[] }) {
  return (
    <ul aria-label={en.steps.showTree} className="font-mono text-xs leading-relaxed">
      {windows.map((window) => (
        <Node key={window.ref} node={window} depth={0} />
      ))}
    </ul>
  )
}
