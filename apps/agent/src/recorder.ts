import {
  RECORDED_STEP_ID,
  RECORDING_SNAP_DIR,
  decidePopup,
  normalizeButtonText,
  snapshotPath,
  validatePopupsSource,
  walkTree,
  type ElementNode,
  type Locator,
  type Popups,
  type Redactor,
  type Step,
  protocol,
} from '@coral/shared'
import {
  MAX_POPUPS_PER_STEP,
  StepFailure,
  createPopupGuard,
  extractLocators,
  findPopups,
  observedImagesFromPng,
  pickTarget,
  realClock,
  snapshotFromPng,
  suggestExpects,
  topNodeAt,
  waitForStable,
  type Clock,
  type DeviceDriver,
  type Point,
  type ResolveContext,
} from '@coral/runner'

type AgentCommand = protocol.Payload<'device.command'>['command']
type PrepareCommand = Extract<AgentCommand, { kind: 'prepare' }>
type RecordCommand = Extract<AgentCommand, { kind: 'record' }>
type RecordResult = protocol.CommandResult<'record'>
type ObserveCommand = Extract<AgentCommand, { kind: 'observe' }>
type ObserveResult = protocol.CommandResult<'observe'>

/** How far back `observe` reads the device log to explain a crash. */
export const CRASH_LOG_WINDOW_MS = 60_000

/** Gesture lengths when the browser does not say (contracts/ui-ws.md). */
export const LONG_PRESS_MS = 800
export const SWIPE_MS = 300

/** A recorder command the device cannot do (answered with this code, nothing done). */
export class RecorderError extends Error {
  constructor(
    readonly code: 'secret_required' | 'not_recordable' | 'invalid_popups' | 'upload_failed',
    message: string,
  ) {
    super(message)
    this.name = 'RecorderError'
  }
}

export interface RecorderDeps {
  driver: DeviceDriver
  /** Masks the secrets typed so far in the uploaded tree (FR-014). */
  redactor: Redactor
  /** Built by the caller: downloads and caches a build, returns its local path. */
  build?: (build: NonNullable<PrepareCommand['build']>) => Promise<string>
  put: (url: string, body: Uint8Array | string, contentType: string) => Promise<void>
  clock?: Clock
  stableTimeoutMs?: number
}

const pct = (value: number, size: number) =>
  Math.min(1, Math.max(0, Math.round((value / size) * 10_000) / 10_000))
const center = (n: ElementNode): Point => ({
  x: Math.round(n.bounds.x + n.bounds.w / 2),
  y: Math.round(n.bounds.y + n.bounds.h / 2),
})
const isField = (n: ElementNode) => /EditText$/.test(n.class) || n.android?.password === true

function popupsOf(yaml: string): Popups {
  const popups = validatePopupsSource(yaml, 'popups.yaml').value
  if (!popups) throw new RecorderError('invalid_popups', 'popups.yaml of the project is not valid')
  return popups
}

async function stable(deps: RecorderDeps): Promise<ElementNode[]> {
  const options = deps.stableTimeoutMs ? { timeoutMs: deps.stableTimeoutMs } : {}
  return (await waitForStable(deps.driver, deps.clock ?? realClock, options)).tree
}

async function context(deps: RecorderDeps, appId: string): Promise<ResolveContext> {
  return { platform: deps.driver.platform, screen: await deps.driver.windowSize(), appId }
}

/** Screen, tree (secrets masked) and, when given, the element cut-out, to the presigned URLs. */
async function upload(
  deps: RecorderDeps,
  tree: readonly ElementNode[],
  ctx: ResolveContext,
  urls: { screen: string; tree: string; element?: string },
  element?: ElementNode,
): Promise<boolean> {
  const snapshot = snapshotFromPng(await deps.driver.screenshot(), ctx.screen, element?.bounds)
  const uploads = [
    deps.put(urls.screen, snapshot.screen, 'image/jpeg'),
    deps.put(urls.tree, JSON.stringify(deps.redactor.value(tree)), 'application/json'),
  ]
  if (urls.element && snapshot.element) {
    uploads.push(deps.put(urls.element, snapshot.element, 'image/png'))
  }
  await Promise.all(uploads)
  return snapshot.element !== undefined
}

/**
 * `prepare` (research R8, contracts/agent-ws-phase2.md): the app under test as the recording
 * starts — the build installed when its sha256 changed, the data cleared for a fresh start, the
 * app launched, popups right after launch handled by the project's rules — and a first snapshot.
 */
export async function prepare(
  deps: RecorderDeps,
  command: PrepareCommand,
): Promise<protocol.CommandResult<'prepare'>> {
  const { driver } = deps
  const popups = popupsOf(command.popups_yaml)
  if (command.build) {
    if (!deps.build) throw new RecorderError('not_recordable', 'this agent cannot install builds')
    await driver.install(await deps.build(command.build), command.build.sha256)
  }
  if (command.app_state === 'fresh') await driver.resetApp(command.package)
  await driver.launch(command.package)
  const ctx = await context(deps, command.package)
  const guard = createPopupGuard({ popups, driver })
  let tree = await stable(deps)
  for (let handled = 0; handled < MAX_POPUPS_PER_STEP; handled += 1) {
    const popup = await guard.handle(tree, {
      appId: command.package,
      reason: 'launch',
      resolveCtx: ctx,
      limitReached: false,
    })
    if (!popup) break
    tree = await stable(deps)
  }
  await upload(deps, tree, ctx, command.upload)
  return { screen_width: ctx.screen.width, screen_height: ctx.screen.height }
}

/** The focused field of the tree, where typed text goes. */
const focusedField = (tree: readonly ElementNode[]) =>
  [...walkTree(tree)].find((n) => n.visible && n.android?.focused === true && isField(n))

/**
 * `record` (research R8–R9): reads the stable screen, turns the action into a `coral/testcase@1`
 * step — the element under a click with its locator chain and cut-out, the focused field for typed
 * text — uploads the snapshot taken before acting, acts (a tap at the centre of the element, as a
 * replay will), waits for the screen to settle and suggests expectations. A tap into a popup that
 * a project rule handles is done but gives no step (FR-015); a never_tap button gives a warning.
 */
export async function record(deps: RecorderDeps, command: RecordCommand): Promise<RecordResult> {
  const { driver } = deps
  const { action } = command
  const popups = popupsOf(command.popups_yaml)
  const ctx = await context(deps, command.package)
  const before = await stable(deps)
  const sizes = { screen_width: ctx.screen.width, screen_height: ctx.screen.height }
  const warnings: RecordResult['warnings'] = []

  let step: Step
  let element: ElementNode | undefined
  let act: () => Promise<void>
  let targetPassword: boolean | undefined
  let popupRule: string | undefined

  switch (action.kind) {
    case 'tap':
    case 'long_press': {
      const click = { x: action.x, y: action.y }
      const target = pickTarget(before, click)
      let chain: Locator[]
      let point: Point
      if (target?.clickable) {
        element = target
        point = center(target)
        chain = extractLocators(target, before, ctx, {
          image: {
            path: snapshotPath(RECORDING_SNAP_DIR, RECORDED_STEP_ID, 'element.png'),
            screen_width: ctx.screen.width,
          },
        })
        const label = normalizeButtonText(target.text || target.desc)
        if (label && popups.never_tap.map(normalizeButtonText).includes(label)) {
          warnings.push('never_tap')
        }
        const popup = findPopups(before, command.package).find((p) =>
          p.nodes.some((n) => n.ref === target.ref),
        )
        const decision = popup ? decidePopup(popups, popup.nodes) : undefined
        if (decision?.kind === 'tap') popupRule = decision.rule
      } else {
        // Nothing clickable there: the replay taps the same spot of the screen.
        point = click
        chain = [{ point_pct: [pct(click.x, ctx.screen.width), pct(click.y, ctx.screen.height)] }]
      }
      step =
        action.kind === 'tap'
          ? { id: RECORDED_STEP_ID, action: 'tap', target: chain }
          : {
              id: RECORDED_STEP_ID,
              action: 'long_press',
              target: chain,
              ...(action.ms !== undefined ? { ms: action.ms } : {}),
            }
      if (!popupRule) warnings.push('no_expect_after_tap')
      act =
        action.kind === 'tap'
          ? () => driver.tapAt(point)
          : () => driver.longPressAt(point, action.ms ?? LONG_PRESS_MS)
      break
    }
    case 'swipe': {
      const { from, to } = action
      step = {
        id: RECORDED_STEP_ID,
        action: 'swipe',
        from: [pct(from.x, ctx.screen.width), pct(from.y, ctx.screen.height)],
        to: [pct(to.x, ctx.screen.width), pct(to.y, ctx.screen.height)],
        ...(action.ms !== undefined ? { ms: action.ms } : {}),
      }
      act = () => driver.swipe(from, to, action.ms ?? SWIPE_MS)
      break
    }
    case 'type': {
      const field = focusedField(before)
      targetPassword = field?.android?.password === true
      // A password is always a secret reference, never text in the test case (FR-014).
      if (targetPassword && action.secret === undefined) {
        throw new RecorderError('secret_required', 'a password field takes a secret')
      }
      const value = action.secret !== undefined ? `\${secret:${action.secret}}` : action.text
      const chain = field ? extractLocators(field, before, ctx) : undefined
      step = {
        id: RECORDED_STEP_ID,
        action: 'type',
        ...(chain && chain.length > 0 ? { target: chain } : {}),
        value,
      }
      act = () => driver.type(action.text)
      break
    }
    case 'back':
      step = { id: RECORDED_STEP_ID, action: 'back' }
      act = () => driver.back()
      break
    case 'hide_keyboard':
      step = { id: RECORDED_STEP_ID, action: 'hide_keyboard' }
      act = () => driver.hideKeyboard()
      break
    default:
      throw new RecorderError('not_recordable', `${action.kind} is not a test step`)
  }

  if (popupRule) {
    // The rule does this at every run: done now, not recorded (FR-015).
    await act()
    await stable(deps)
    return { suggestions: [], warnings: [], popup_rule: popupRule, ...sizes }
  }
  const cut = await upload(deps, before, ctx, command.upload, element)
  if (!cut && 'target' in step && step.target) {
    // No cut-out (element off the screenshot): no image locator either.
    step = { ...step, target: step.target.filter((l) => l.image === undefined) }
  }
  await act()
  const after = await stable(deps)
  return {
    step,
    suggestions: suggestExpects(before, after, ctx),
    warnings,
    ...(targetPassword !== undefined ? { target_password: targetPassword } : {}),
    ...sizes,
  }
}

/**
 * `inspect` (Assert mode, research R8 steps 1–3): the element drawn at the point — a label too, not
 * only something clickable — with its locators and text; nothing is touched. A field's content is
 * never sent (it may be a secret); other secret values become `${secret:NAME}` on the server.
 */
export async function inspect(
  deps: RecorderDeps,
  point: Point,
  appId: string | undefined,
): Promise<protocol.CommandResult<'inspect'>> {
  const tree = await stable(deps)
  const ctx: ResolveContext = {
    platform: deps.driver.platform,
    screen: await deps.driver.windowSize(),
    ...(appId ? { appId } : {}),
  }
  const node = topNodeAt(tree, point)
  if (!node) throw new RecorderError('not_recordable', 'nothing on screen there')
  const field = isField(node)
  return {
    element: { ...node, ...(field ? { text: '' } : {}), children: [] },
    locators: extractLocators(node, tree, ctx),
    text: field ? '' : node.text,
  }
}

/**
 * The lines of a device log about a crash or ANR of `appId` (logcat threadtime): from the
 * `FATAL EXCEPTION` / `ANR in` line on, masked and cut to the protocol's 4 KB.
 */
export function crashExcerpt(
  log: string,
  appId: string,
  redactor: Redactor,
): { kind: 'crashed' | 'not_responding'; excerpt: string } | undefined {
  const lines = log.split('\n')
  const fatal = lines.findIndex(
    (line, i) =>
      line.includes('FATAL EXCEPTION') &&
      lines.slice(i, i + 4).some((next) => next.includes(`Process: ${appId}`)),
  )
  const anr = lines.findIndex((line) => line.includes(`ANR in ${appId}`))
  const start = fatal >= 0 ? fatal : anr
  if (start < 0) return undefined
  const excerpt = redactor.text(lines.slice(start, start + 60).join('\n'))
  return {
    kind: fatal >= 0 ? 'crashed' : 'not_responding',
    excerpt: excerpt.slice(0, protocol.MAX_LOG_EXCERPT),
  }
}

/**
 * `observe` (contracts/agent-ws-phase3.md, research R7): what the Explorer looks at before each
 * decision. Waits for a stable screen, lets the project's popup rules handle up to 3 popups
 * (never_tap respected; unknown popups stay for the AI), takes one screenshot for `screen.jpg`
 * and `ai.jpg`, and returns the tree with secrets masked. A crash or ANR of the app under test is
 * reported with its log, never dismissed.
 */
export async function observe(deps: RecorderDeps, command: ObserveCommand): Promise<ObserveResult> {
  const { driver } = deps
  const clock = deps.clock ?? realClock
  const appId = command.package
  const popups = popupsOf(command.popups_yaml)
  const ctx = await context(deps, appId)
  const guard = createPopupGuard({ popups, driver })
  const handled: string[] = []
  let crash: ObserveResult['crash'] = null
  let tree = await stable(deps)
  for (let i = 0; i < MAX_POPUPS_PER_STEP; i += 1) {
    try {
      // `launch`: a popup no rule knows is left for the AI to deal with.
      const popup = await guard.handle(tree, {
        appId,
        reason: 'launch',
        resolveCtx: ctx,
        limitReached: false,
      })
      if (!popup) break
      handled.push(popup.rule)
      tree = await stable(deps)
    } catch (error) {
      if (!(error instanceof StepFailure)) throw error
      if (error.code === 'APP_CRASHED' || error.code === 'APP_NOT_RESPONDING') {
        crash = {
          kind: error.code === 'APP_CRASHED' ? 'crashed' : 'not_responding',
          log_excerpt: '',
        }
      }
      break
    }
  }

  const appRunning = await driver.isAppRunning(appId)
  if (crash || !appRunning) {
    const log = await driver.deviceLogs(clock.now() - CRASH_LOG_WINDOW_MS).catch(() => '')
    const found = crashExcerpt(log, appId, deps.redactor)
    if (found) crash = { kind: crash?.kind ?? found.kind, log_excerpt: found.excerpt }
  }

  const masked = deps.redactor.value(tree)
  const treeJson = JSON.stringify(masked)
  if (treeJson.length > protocol.MAX_OBSERVE_TREE_BYTES) {
    throw new RecorderError(
      'not_recordable',
      `the screen's tree is over ${protocol.MAX_OBSERVE_TREE_BYTES} bytes`,
    )
  }
  const images = observedImagesFromPng(await driver.screenshot())
  try {
    await Promise.all([
      deps.put(command.upload.screen, images.screen, 'image/jpeg'),
      deps.put(command.upload.ai, images.ai, 'image/jpeg'),
      deps.put(command.upload.tree, treeJson, 'application/json'),
    ])
  } catch (error) {
    throw new RecorderError(
      'upload_failed',
      error instanceof Error ? error.message : 'snapshot upload failed',
    )
  }
  const foreground = await driver.foregroundActivity?.().catch(() => undefined)
  return {
    screen_width: ctx.screen.width,
    screen_height: ctx.screen.height,
    package: foreground?.package ?? appId,
    ...(foreground?.activity ? { activity: foreground.activity } : {}),
    app_running: appRunning,
    crash,
    popups_handled: handled,
    tree: masked,
  }
}
