import { createRedactor, type Redactor } from '@coral/shared'
import { pino, type DestinationStream, type LogFn, type Logger } from 'pino'

/**
 * Secret values the agent has received in `job.assign`. They are kept for the life of the
 * process, so a late log line about a finished job is masked too (SPEC §8.6, D19).
 */
export class SecretValues {
  private readonly values = new Set<string>()
  private current: Redactor = createRedactor([])

  add(values: Iterable<string>): void {
    const before = this.values.size
    for (const value of values) this.values.add(value)
    if (this.values.size !== before) this.current = createRedactor(this.values)
  }

  get redactor(): Redactor {
    return this.current
  }
}

const isPlainObject = (value: object) => {
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Copy of a log argument with every secret masked. Errors stay errors (message, stack, cause and
 * own fields masked) so pino's serializer still prints them; other class instances are kept as is.
 */
export function redactLogArg(value: unknown, redactor: Redactor, parents: object[] = []): unknown {
  if (typeof value === 'string') return redactor.text(value)
  if (value === null || typeof value !== 'object') return value
  if (parents.includes(value)) return '[Circular]'
  const inner = [...parents, value]
  if (value instanceof Error) {
    const copy = new Error(redactor.text(value.message))
    copy.name = value.name
    if (value.stack !== undefined) copy.stack = redactor.text(value.stack)
    if (value.cause !== undefined) copy.cause = redactLogArg(value.cause, redactor, inner)
    for (const [key, field] of Object.entries(value)) {
      ;(copy as unknown as Record<string, unknown>)[key] = redactLogArg(field, redactor, inner)
    }
    return copy
  }
  if (Array.isArray(value)) return value.map((item) => redactLogArg(item, redactor, inner))
  if (!isPlainObject(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [key, redactLogArg(field, redactor, inner)]),
  )
}

/** The agent's pino logger: every argument of every log call goes through the redactor first. */
export function createAgentLogger(options: {
  level: string
  secrets: SecretValues
  destination?: DestinationStream
}): Logger {
  const config = {
    level: options.level,
    base: { service: 'coral-agent' },
    hooks: {
      logMethod(this: Logger, args: Parameters<LogFn>, method: LogFn) {
        const redactor = options.secrets.redactor
        const masked = args.map((arg) => redactLogArg(arg, redactor)) as Parameters<LogFn>
        method.apply(this, masked)
      },
    },
  }
  return options.destination ? pino(config, options.destination) : pino(config)
}
