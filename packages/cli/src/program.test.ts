import { CORAL_VERSION } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { createProgram } from './program'

function run(args: string[]): string {
  let output = ''
  const program = createProgram()
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        output += text
      },
      writeErr: (text) => {
        output += text
      },
    })
  try {
    program.parse(args, { from: 'user' })
  } catch {
    // exitOverride() turns --help / --version exits into exceptions.
  }
  return output
}

describe('coral CLI', () => {
  it('prints the shared version', () => {
    expect(run(['--version']).trim()).toBe(CORAL_VERSION)
  })

  it('prints help naming the command', () => {
    expect(run(['--help'])).toContain('Usage: coral')
  })
})
