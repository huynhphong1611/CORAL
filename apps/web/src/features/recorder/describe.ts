import type { ExpectCondition, Locator, Step } from '@coral/shared'

const quoted = (text: string) => `“${text}”`
const pct = (value: number) => `${Math.round(value * 100)}%`

/** One locator in a few words (step list, Assert mode). */
export function locatorLabel(locator: Locator): string {
  if (locator.android_id !== undefined) return locator.android_id
  if (locator.ios_id !== undefined) return locator.ios_id
  if (locator.text !== undefined) return `text ${quoted(locator.text)}`
  if (locator.text_contains !== undefined) return `text contains ${quoted(locator.text_contains)}`
  if (locator.desc !== undefined) return `desc ${quoted(locator.desc)}`
  if (locator.rel) {
    const [direction, anchor] = Object.entries(locator.rel).find(([k]) => k !== 'class') ?? []
    const of = anchor && typeof anchor === 'object' ? locatorLabel(anchor as Locator) : '?'
    return `${locator.rel.class ?? 'element'} ${direction?.replace('_', ' ') ?? ''} ${of}`
  }
  if (locator.class_index) {
    const { class: cls, index, within } = locator.class_index
    return `${cls}[${index}]${within ? ` in ${locatorLabel(within)}` : ''}`
  }
  if (locator.image !== undefined) return 'image'
  if (locator.point_pct) return `point ${pct(locator.point_pct[0])}, ${pct(locator.point_pct[1])}`
  return '?'
}

const firstOf = (value: Locator | Locator[]) => (Array.isArray(value) ? value[0] : value)

/** One expectation in a few words (chips, the step's Expect line). */
export function conditionLabel(condition: ExpectCondition): string {
  if (condition.visible_text !== undefined) return `text ${quoted(condition.visible_text)}`
  const visible = condition.visible ? firstOf(condition.visible) : undefined
  if (visible) return `${locatorLabel(visible)} visible`
  const gone = condition.not_visible ? firstOf(condition.not_visible) : undefined
  if (gone) return `${locatorLabel(gone)} not visible`
  if (condition.screen !== undefined) return `screen ${condition.screen}`
  return '?'
}

/** What the step does, e.g. `tap id/menuIV`, `type ${secret:TEST_USER}`. */
export function stepSummary(step: Step): string {
  const target = 'target' in step && step.target?.[0] ? locatorLabel(step.target[0]) : ''
  switch (step.action) {
    case 'type':
      return `type ${quoted(step.value)}${target ? ` into ${target}` : ''}`
    case 'swipe':
      return step.from && step.to
        ? `swipe ${pct(step.from[0])},${pct(step.from[1])} → ${pct(step.to[0])},${pct(step.to[1])}`
        : `swipe ${step.direction ?? ''}`
    case 'long_press':
      return `long press ${target}${step.ms ? ` (${step.ms} ms)` : ''}`
    default:
      return `${step.action.replace('_', ' ')}${target ? ` ${target}` : ''}`
  }
}
