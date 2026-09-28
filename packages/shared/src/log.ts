/** Log levels accepted by CORAL_LOG_LEVEL in every Node service (pino levels). */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const

export type LogLevel = (typeof LOG_LEVELS)[number]
