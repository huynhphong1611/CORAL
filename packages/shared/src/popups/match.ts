import { walkTree, type ElementNode } from '../element'
import { normalizeButtonText, type PopupRule, type Popups } from './schema'

/**
 * Packages of the Android runtime-permission dialog, which moved between Android versions and
 * vendors (research R6). A rule on any of them matches all of them, so the default rule
 * `package: com.android.permissioncontroller` also covers Google's build of the dialog.
 */
export const PERMISSION_PACKAGES = [
  'com.android.permissioncontroller',
  'com.google.android.permissioncontroller',
  'com.android.packageinstaller',
] as const

const isPermissionPackage = (pkg: string) =>
  (PERMISSION_PACKAGES as readonly string[]).includes(pkg)

function packageMatches(wanted: string, actual: string): boolean {
  return actual === wanted || (isPermissionPackage(wanted) && isPermissionPackage(actual))
}

function idMatches(wanted: string, actual: string): boolean {
  return actual === wanted || (!wanted.includes(':') && actual.endsWith(`:${wanted}`))
}

const visibleNodes = (nodes: readonly ElementNode[]) =>
  [...walkTree(nodes)].filter((n) => n.visible)

/** Every key of `match` must hold on the popup's nodes (SPEC §9.2); text is case-insensitive. */
export function ruleMatches(rule: PopupRule, popup: readonly ElementNode[]): boolean {
  const nodes = visibleNodes(popup)
  const texts = nodes
    .flatMap((n) => [n.text, n.desc])
    .filter(Boolean)
    .map(normalizeButtonText)
  const { match } = rule
  if (match.package !== undefined) {
    const wanted = match.package
    if (!nodes.some((n) => packageMatches(wanted, n.package_or_bundle))) return false
  }
  if (match.resource_id !== undefined) {
    const wanted = match.resource_id
    if (!nodes.some((n) => idMatches(wanted, n.platform_id))) return false
  }
  for (const key of ['alert_contains', 'text_contains'] as const) {
    const wanted = match[key]
    if (wanted !== undefined) {
      const needle = normalizeButtonText(wanted)
      if (!texts.some((t) => t.includes(needle))) return false
    }
  }
  return true
}

export type PopupDecision =
  /** Tap this node. */
  | { kind: 'tap'; rule: string; button: string; node: ElementNode }
  /** A rule matched, but every button it may press is missing or in never_tap. */
  | { kind: 'blocked'; rule: string; reason: string }
  /** No rule matches this popup. */
  | { kind: 'unknown' }

/**
 * First matching rule decides; its `tap_any` buttons are tried in order and a button listed in
 * `never_tap` is never chosen (P6, §9.4). Buttons match text or content-desc exactly after
 * normalisation.
 */
export function decidePopup(popups: Popups, popup: readonly ElementNode[]): PopupDecision {
  const forbidden = new Set(popups.never_tap.map(normalizeButtonText))
  const nodes = visibleNodes(popup)
  for (const rule of popups.rules) {
    if (!ruleMatches(rule, popup)) continue
    for (const button of rule.tap_any) {
      const wanted = normalizeButtonText(button)
      if (forbidden.has(wanted)) continue
      const node = nodes.find(
        (n) =>
          (n.text && normalizeButtonText(n.text) === wanted) ||
          (n.desc && normalizeButtonText(n.desc) === wanted),
      )
      if (node && !forbidden.has(normalizeButtonText(node.text || node.desc))) {
        return { kind: 'tap', rule: rule.name, button, node }
      }
    }
    return {
      kind: 'blocked',
      rule: rule.name,
      reason: 'no allowed button of the rule is on screen',
    }
  }
  return { kind: 'unknown' }
}
