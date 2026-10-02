import { examples } from '../testing/fixtures'
import { describe, expect, it } from 'vitest'
import { validateMcpSource } from './schema'

const source = `schema: coral/mcp@1
servers:
  otp:
    url: https://otp.test.example.com/mcp
    headers: { Authorization: 'Bearer \${secret:OTP_TOKEN}' }
    roles: [explorer, writer]
    tools:
      get_otp: {}
      send_sms: { side_effects: true }
`

const issues = (text: string, stdioAllowlist?: string[]) => {
  const result = validateMcpSource(text, 'mcp.yaml', stdioAllowlist ? { stdioAllowlist } : {})
  return [...result.errors, ...result.warnings].map((e) => [e.code, e.line])
}

describe('validateMcpSource', () => {
  it('accepts examples/mcp.example.yaml, without a warning', () => {
    const result = validateMcpSource(examples['mcp.example.yaml'] ?? '', 'mcp.yaml')
    expect(result).toMatchObject({ valid: true, errors: [], warnings: [] })
    expect(Object.keys(result.value?.servers.otp?.tools ?? {})).toEqual(['get_otp', 'send_sms'])
  })

  it('accepts a remote server with an allowlist', () => {
    const result = validateMcpSource(source)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.value?.servers.otp?.tools).toEqual({
      get_otp: { side_effects: false, expose: false },
      send_sms: { side_effects: true, expose: false },
    })
  })

  it('warns about a credential typed in clear', () => {
    expect(
      issues(source.replace("'Bearer ${secret:OTP_TOKEN}'", "'Bearer abcdef0123456789'")),
    ).toEqual([['inline_credential', 5]])
  })

  it('refuses local servers outside the platform allowlist', () => {
    const local = `schema: coral/mcp@1
servers:
  playwright:
    command: playwright-mcp
    tools: { browser_snapshot: {} }
`
    expect(issues(local)).toEqual([['stdio_not_allowed', 4]])
    expect(issues(local, ['playwright'])).toEqual([])
  })

  it('needs exactly one of url and command, and http(s) urls', () => {
    expect(issues(source.replace('url: https://otp.test.example.com/mcp', 'command: x'))).toEqual([
      ['stdio_not_allowed', 4],
    ])
    expect(issues(source.replace('https://', 'ftp://'))[0]?.[0]).toBe('schema')
    expect(issues(source.replace('    url:', '    command: x\n    url:'))[0]?.[0]).toBe('schema')
    expect(issues(source.replace('roles: [explorer, writer]', 'roles: [tester]'))[0]?.[0]).toBe(
      'schema',
    )
  })
})
