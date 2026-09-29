// @ts-check
/**
 * Dependency boundary rules (SPEC P1, D08):
 *   1. Only `@coral/brain` may depend on an LLM SDK.
 *   2. Only `@coral/server` may depend on `@coral/brain`.
 *   3. Apps (`apps/*`) never depend on other apps.
 *   4. The browser app (`@coral/web`) never depends on Node-only workspace packages such as the
 *      runner: it reaches devices through the server (Phase 2 plan).
 * Rules 1–2 are also checked transitively through pnpm-lock.yaml, so a runtime
 * package cannot reach an LLM SDK through a workspace package or a third-party one.
 */

export const BRAIN_PACKAGE = '@coral/brain'
export const BRAIN_CONSUMERS = ['@coral/server']
export const BROWSER_APP = '@coral/web'
/** Workspace packages that need Node (processes, sockets, the file system). */
export const NODE_ONLY_PACKAGES = ['@coral/runner', '@coral/cli']

/** Exact names, or `@scope/*` for a whole scope. */
export const LLM_SDK_PATTERNS = [
  '@anthropic-ai/*',
  '@google/genai',
  '@google/generative-ai',
  '@google-cloud/vertexai',
  '@github/copilot-sdk',
  '@aws-sdk/client-bedrock-runtime',
  'openai',
  '@openai/*',
  'ai',
  '@ai-sdk/*',
  'langchain',
  '@langchain/*',
  'llamaindex',
  'ollama',
  '@mistralai/*',
  'cohere-ai',
  'groq-sdk',
]

/**
 * @param {string} name
 * @param {string} pattern
 */
export function matchesPattern(name, pattern) {
  if (pattern.endsWith('/*')) return name.startsWith(pattern.slice(0, -1))
  return name === pattern
}

/** @param {string} name */
export function isLlmSdk(name) {
  return LLM_SDK_PATTERNS.some((pattern) => matchesPattern(name, pattern))
}

/**
 * @typedef {object} WorkspacePackage
 * @property {string} name     package.json name, e.g. "@coral/agent"
 * @property {string} dir      path relative to the repo root, e.g. "apps/agent"
 * @property {Record<string, Record<string, string> | undefined>} manifest  raw package.json
 */

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]

/** @param {WorkspacePackage} pkg */
function isApp(pkg) {
  return pkg.dir.startsWith('apps/')
}

/**
 * Checks direct dependencies declared in every workspace package.json.
 * @param {WorkspacePackage[]} packages
 * @returns {string[]} human-readable violations
 */
export function checkManifests(packages) {
  const appNames = new Set(packages.filter(isApp).map((pkg) => pkg.name))
  /** @type {string[]} */
  const violations = []
  for (const pkg of packages) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const dep of Object.keys(pkg.manifest[field] ?? {})) {
        if (isLlmSdk(dep) && pkg.name !== BRAIN_PACKAGE) {
          violations.push(
            `${pkg.name} (${field}) depends on LLM SDK "${dep}" — only ${BRAIN_PACKAGE} may.`,
          )
        }
        if (dep === BRAIN_PACKAGE && !BRAIN_CONSUMERS.includes(pkg.name)) {
          violations.push(
            `${pkg.name} (${field}) depends on ${BRAIN_PACKAGE} — only ${BRAIN_CONSUMERS.join(', ')} may.`,
          )
        }
        if (pkg.name === BROWSER_APP && NODE_ONLY_PACKAGES.includes(dep)) {
          violations.push(
            `${pkg.name} (${field}) depends on Node-only "${dep}" — the web app runs in the browser.`,
          )
        }
        if (appNames.has(dep) && dep !== pkg.name) {
          violations.push(
            `${pkg.name} (${field}) depends on app "${dep}" — apps are not libraries.`,
          )
        }
      }
    }
  }
  return violations
}

/**
 * @typedef {Record<string, string | { version: string }>} LockDeps
 * @typedef {object} Lockfile
 * @property {Record<string, { dependencies?: LockDeps, devDependencies?: LockDeps, optionalDependencies?: LockDeps }>} [importers]
 * @property {Record<string, { dependencies?: Record<string, string>, optionalDependencies?: Record<string, string> }>} [snapshots]
 */

/** @param {string | { version: string }} entry */
function versionOf(entry) {
  return typeof entry === 'string' ? entry : entry.version
}

/**
 * Normalises a repo-relative path ("apps/agent/../../packages/shared" → "packages/shared").
 * @param {string} path
 */
function normalisePath(path) {
  /** @type {string[]} */
  const parts = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

/**
 * @typedef {object} Reached
 * @property {string} name    real package name (the workspace name for `link:` entries)
 * @property {string} alias   name the dependency is declared under (differs for npm aliases)
 * @property {string[]} chain dependency names from the start package down to this one
 */

/**
 * Walks the dependency closure of one workspace package through pnpm-lock.yaml (v9): workspace
 * links and third-party snapshots alike, each package walked once. Every dependency entry met is
 * returned; `stop(reached)` true keeps the walk from going below it.
 * @param {Lockfile} lockfile
 * @param {WorkspacePackage[]} packages
 * @param {WorkspacePackage} start
 * @param {{ dev: boolean, stop?: (reached: Reached) => boolean }} options  dev: include the
 *   start package's devDependencies (never those of what it depends on)
 * @returns {Reached[]}
 */
function walkLockfile(lockfile, packages, start, options) {
  const importers = lockfile.importers ?? {}
  const snapshots = lockfile.snapshots ?? {}
  const nameByDir = new Map(packages.map((pkg) => [pkg.dir, pkg.name]))
  const importer = importers[start.dir]
  if (!importer) return []

  /** @type {Reached[]} */
  const reached = []
  /** @type {Set<string>} */
  const visited = new Set()
  /** @type {Array<{ deps: LockDeps | Record<string, string>, fromDir: string | null, chain: string[] }>} */
  const queue = [
    { deps: importer.dependencies ?? {}, fromDir: start.dir, chain: [start.name] },
    {
      deps: options.dev ? (importer.devDependencies ?? {}) : {},
      fromDir: start.dir,
      chain: [start.name],
    },
    { deps: importer.optionalDependencies ?? {}, fromDir: start.dir, chain: [start.name] },
  ]

  while (queue.length > 0) {
    const item = queue.shift()
    if (!item) break
    for (const [alias, entry] of Object.entries(item.deps)) {
      const version = versionOf(entry)
      const chain = [...item.chain, alias]

      if (version.startsWith('link:')) {
        const dir = normalisePath(`${item.fromDir ?? ''}/${version.slice('link:'.length)}`)
        const hit = { name: nameByDir.get(dir) ?? alias, alias, chain }
        reached.push(hit)
        if (options.stop?.(hit) || visited.has(`link:${dir}`)) continue
        visited.add(`link:${dir}`)
        const linked = importers[dir]
        if (linked) {
          queue.push({ deps: linked.dependencies ?? {}, fromDir: dir, chain })
          queue.push({ deps: linked.optionalDependencies ?? {}, fromDir: dir, chain })
        }
        continue
      }

      // Aliased dependencies store "real-name@version" as their version.
      const key = snapshots[`${alias}@${version}`] ? `${alias}@${version}` : version
      const at = key.indexOf('@', 1)
      const hit = { name: at > 0 ? key.slice(0, at) : alias, alias, chain }
      reached.push(hit)
      if (options.stop?.(hit) || visited.has(key)) continue
      visited.add(key)
      const snapshot = snapshots[key]
      if (snapshot) {
        queue.push({ deps: snapshot.dependencies ?? {}, fromDir: null, chain })
        queue.push({ deps: snapshot.optionalDependencies ?? {}, fromDir: null, chain })
      }
    }
  }
  return reached
}

/**
 * Walks the full dependency closure (workspace + third-party) of every workspace package
 * that is not allowed to reach an LLM SDK or @coral/brain, using pnpm-lock.yaml (v9).
 * @param {Lockfile} lockfile
 * @param {WorkspacePackage[]} packages
 * @returns {string[]}
 */
export function checkLockfile(lockfile, packages) {
  /** @param {Reached} r */
  const isSdk = (r) => isLlmSdk(r.name) || isLlmSdk(r.alias)
  /** @type {string[]} */
  const violations = []
  for (const pkg of packages) {
    if (pkg.name === BRAIN_PACKAGE || BRAIN_CONSUMERS.includes(pkg.name)) continue
    const stop = (/** @type {Reached} */ r) => r.name === BRAIN_PACKAGE || isSdk(r)
    for (const r of walkLockfile(lockfile, packages, pkg, { dev: true, stop })) {
      if (r.name === BRAIN_PACKAGE) {
        violations.push(`${pkg.name} reaches ${BRAIN_PACKAGE}: ${r.chain.join(' → ')}`)
      } else if (isSdk(r)) {
        violations.push(`${pkg.name} reaches LLM SDK "${r.name}": ${r.chain.join(' → ')}`)
      }
    }
  }
  return violations
}

/**
 * Names (real and alias) of every package a workspace package needs at run time: its
 * dependencies and optionalDependencies, transitively, per pnpm-lock.yaml (SC-010).
 * @param {Lockfile} lockfile
 * @param {WorkspacePackage[]} packages
 * @param {string} name  workspace package name, e.g. "@coral/agent"
 * @returns {Set<string>}
 */
export function runtimeClosure(lockfile, packages, name) {
  const start = packages.find((pkg) => pkg.name === name)
  if (!start || !lockfile.importers?.[start.dir]) throw new Error(`${name} is not in the lockfile`)
  return new Set(
    walkLockfile(lockfile, packages, start, { dev: false }).flatMap((r) => [r.name, r.alias]),
  )
}

/**
 * Options for ESLint's `no-restricted-imports` so editors flag violations early.
 * @param {{ llmSdks: boolean, brain: boolean, apps: string[] }} restrict
 */
export function restrictedImports(restrict) {
  /** @type {Array<{ name: string, message: string }>} */
  const paths = []
  /** @type {Array<{ group: string[], message: string }>} */
  const patterns = []

  /**
   * @param {string} pattern
   * @param {string} message
   */
  const add = (pattern, message) => {
    if (pattern.endsWith('/*')) {
      patterns.push({ group: [pattern], message })
    } else {
      paths.push({ name: pattern, message })
      patterns.push({ group: [`${pattern}/*`], message })
    }
  }

  if (restrict.llmSdks) {
    for (const pattern of LLM_SDK_PATTERNS) {
      add(pattern, `SPEC P1: only ${BRAIN_PACKAGE} may use LLM SDKs.`)
    }
  }
  if (restrict.brain) {
    add(BRAIN_PACKAGE, `SPEC P1: only ${BRAIN_CONSUMERS.join(', ')} may import ${BRAIN_PACKAGE}.`)
  }
  for (const app of restrict.apps) {
    add(app, 'Apps are not libraries; move shared code into packages/*.')
  }
  return { paths, patterns }
}
