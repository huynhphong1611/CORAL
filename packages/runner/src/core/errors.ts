import type { ElementNode, FailureCode } from '@coral/shared'

/** A step ends with one of the §8.5 codes. */
export class StepFailure extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
  ) {
    super(message)
    this.name = 'StepFailure'
  }
}

/** The target is under another element (bottom sheet, keyboard, popup): §8.4. */
export class TargetCoveredError extends StepFailure {
  constructor(readonly covering: ElementNode | undefined) {
    super(
      'TARGET_NOT_FOUND',
      covering
        ? `target is covered by ${covering.class}${covering.platform_id ? ` ${covering.platform_id}` : ''}`
        : 'target is covered',
    )
    this.name = 'TargetCoveredError'
  }
}
