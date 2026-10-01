import type { ElementFlag, ImageInput, ScreenElement, ScreenInput } from '@coral/brain'
import { checkHit, extractLocators, findAll, type ResolveContext, type Size } from '@coral/runner'
import {
  normalizeButtonText,
  referenceSecrets,
  walkTree,
  type ElementNode,
  type Locator,
} from '@coral/shared'

/** Elements listed to the AI for one screen (research R6). */
export const MAX_LISTED = 80
const MAX_TEXTS = 50
const MAX_LABEL = 80

/** Windows that are never part of what the AI may touch: status bar, keyboards. */
const SYSTEM_WINDOW = /^com\.android\.systemui$|inputmethod|\.ime$|keyboard|honeyboard|swiftkey/i
const FIELD = /(EditText|AutoCompleteTextView|SearchAutoComplete)$/
const SEARCH = /search|tìm|lọc|filter/i

export const isField = (node: ElementNode) =>
  FIELD.test(node.class) || node.android?.password === true

/** A search or filter box: typing into it and submitting is always allowed (FR-022a). */
export function isSearchField(node: ElementNode): boolean {
  return (
    /SearchView|SearchAutoComplete/.test(node.class) ||
    SEARCH.test(node.platform_id) ||
    SEARCH.test(node.desc) ||
    (isField(node) && SEARCH.test(node.text))
  )
}

const shortClass = (name: string) => name.slice(name.lastIndexOf('.') + 1)
const shortId = (platformId: string) =>
  platformId.includes(':id/') ? platformId.slice(platformId.indexOf(':id/') + 4) : platformId
const center = (node: ElementNode) => ({
  x: Math.round(node.bounds.x + node.bounds.w / 2),
  y: Math.round(node.bounds.y + node.bounds.h / 2),
})
const onScreen = (node: ElementNode, screen: Size) =>
  node.bounds.w > 0 &&
  node.bounds.h > 0 &&
  node.bounds.x < screen.width &&
  node.bounds.y < screen.height &&
  node.bounds.x + node.bounds.w > 0 &&
  node.bounds.y + node.bounds.h > 0

/** What identifies an element across visits of a screen: its first recorded locator. */
export function elementKey(locators: readonly Locator[]): string {
  return JSON.stringify(locators[0] ?? {})
}

/** The words a person would read on the element: its own text, else its children's. */
export function labelOf(node: ElementNode): string {
  if (node.text.trim()) return node.text.trim()
  if (node.desc.trim()) return node.desc.trim()
  for (const child of walkTree(node.children)) {
    if (child.visible && child.text.trim()) return child.text.trim()
  }
  return ''
}

export interface ScreenContext {
  appPackage: string
  screen: Size
  /** never_tap of popups.yaml and of the project's skills (SPEC §9.4). */
  neverTap: readonly string[]
  /** Elements the project's skills forbid (rules.yaml `forbidden`). */
  forbidden: readonly Locator[]
  /** Secret values to show as `${secret:NAME}`, name → value (FR-013). */
  secrets: Readonly<Record<string, string>>
  /** Element keys already acted on, and those that changed nothing (frontier). */
  tried?: ReadonlySet<string>
  dead?: ReadonlySet<string>
  knownAs?: string
  image?: ImageInput
}

/** An element the AI may pick by number, with what the system needs to act on it. */
export interface ListedElement {
  n: number
  node: ElementNode
  locators: Locator[]
  key: string
  flags: ElementFlag[]
}

export interface SerializedScreen {
  input: ScreenInput
  elements: ListedElement[]
  /** Actionable elements kept from the AI, and why. */
  excluded: { node: ElementNode; reason: 'never_tap' | 'skill_forbidden' }[]
}

/** `node` is `ancestor` or inside it (a forbidden row forbids its children, not its container). */
const within = (node: ElementNode, ancestor: ElementNode) =>
  node.ref === ancestor.ref || node.ref.startsWith(`${ancestor.ref}.`)

/**
 * The screen as the AI sees it (research R6, contracts/brain.md §2): the elements it can act on
 * — visible, tappable, scrollable or a field, receiving a tap at their centre (D36), in the app's
 * or a popup's window — numbered in reading order, at most 80. never_tap buttons and elements the
 * skills forbid are left out; secret values read on screen become `${secret:NAME}`.
 */
export function serializeScreen(
  tree: readonly ElementNode[],
  ctx: ScreenContext,
): SerializedScreen {
  const resolveCtx: ResolveContext = {
    platform: 'android',
    screen: ctx.screen,
    appId: ctx.appPackage,
  }
  const windows = tree.filter((w) => w.visible && !SYSTEM_WINDOW.test(w.package_or_bundle))
  const neverTap = new Set(ctx.neverTap.map(normalizeButtonText))
  const forbidden = ctx.forbidden.flatMap((locator) => findAll(locator, tree, resolveCtx))

  const actionable: ElementNode[] = []
  const excluded: SerializedScreen['excluded'] = []
  for (const node of walkTree(windows)) {
    if (!node.visible || !onScreen(node, ctx.screen)) continue
    if (!(node.clickable || node.android?.scrollable === true || isField(node))) continue
    if (!checkHit(tree, node, center(node)).ok) continue
    const label = normalizeButtonText(labelOf(node))
    if (label && neverTap.has(label)) {
      excluded.push({ node, reason: 'never_tap' })
      continue
    }
    if (forbidden.some((f) => within(node, f))) {
      excluded.push({ node, reason: 'skill_forbidden' })
      continue
    }
    actionable.push(node)
  }
  actionable.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x)

  const masked = (text: string) => referenceSecrets(text, ctx.secrets).slice(0, MAX_LABEL)
  const elements: ListedElement[] = actionable.slice(0, MAX_LISTED).map((node, i) => {
    const locators = extractLocators(node, tree, resolveCtx)
    const key = elementKey(locators)
    const flags: ElementFlag[] = []
    if (ctx.dead?.has(key)) flags.push('dead')
    else if (ctx.tried?.has(key)) flags.push('tried')
    else flags.push('new')
    if (isField(node)) flags.push('field')
    if (node.android?.password) flags.push('password')
    if (isSearchField(node)) flags.push('search')
    if (node.android?.scrollable) flags.push('scroll')
    return { n: i + 1, node, locators, key, flags }
  })

  const screenElements: ScreenElement[] = elements.map(({ n, node, flags }) => ({
    n,
    className: shortClass(node.class),
    ...(node.platform_id ? { id: shortId(node.platform_id) } : {}),
    ...(node.text.trim() ? { text: masked(node.text.trim()) } : {}),
    ...(node.desc.trim() ? { desc: masked(node.desc.trim()) } : {}),
    bounds: [node.bounds.x, node.bounds.y, node.bounds.w, node.bounds.h],
    flags,
  }))

  const visibleTexts: ScreenInput['visibleTexts'] = []
  const texts = [...walkTree(windows)]
    .filter((n) => n.visible && n.text.trim() && onScreen(n, ctx.screen))
    .sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x)
  for (const node of texts.slice(0, MAX_TEXTS)) {
    visibleTexts.push({ text: masked(node.text.trim()), height: node.bounds.h })
  }

  return {
    input: {
      width: ctx.screen.width,
      height: ctx.screen.height,
      appPackage: ctx.appPackage,
      ...(ctx.knownAs ? { knownAs: ctx.knownAs } : {}),
      elements: screenElements,
      visibleTexts,
      ...(ctx.image ? { image: ctx.image } : {}),
    },
    elements,
    excluded,
  }
}
