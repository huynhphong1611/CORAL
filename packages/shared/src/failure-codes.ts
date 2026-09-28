/** Step / test case failure codes (SPEC §8.5). */
export const FAILURE_CODES = [
  'TARGET_NOT_FOUND',
  'EXPECT_FAILED',
  'APP_CRASHED',
  'APP_NOT_RESPONDING',
  'BLOCKED_BY_POPUP',
  'TIMEOUT',
  'DRIVER_ERROR',
  'DEVICE_OFFLINE',
] as const

export type FailureCode = (typeof FAILURE_CODES)[number]

export function isFailureCode(value: string): value is FailureCode {
  return (FAILURE_CODES as readonly string[]).includes(value)
}
