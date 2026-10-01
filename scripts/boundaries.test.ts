import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  aiSdkKind,
  checkLockfile,
  checkManifests,
  isLlmSdk,
  isMcpSdk,
  restrictedImports,
  type WorkspacePackage,
} from './boundaries.mjs'
import { runChecks } from './check-boundaries.mjs'

function pkg(
  name: string,
  dir: string,
  dependencies: Record<string, string> = {},
  devDependencies: Record<string, string> = {},
): WorkspacePackage {
  return { name, dir, manifest: { dependencies, devDependencies } }
}

describe('isLlmSdk', () => {
  it('matches exact names and whole scopes', () => {
    expect(isLlmSdk('openai')).toBe(true)
    expect(isLlmSdk('@anthropic-ai/sdk')).toBe(true)
    expect(isLlmSdk('@google/genai')).toBe(true)
    expect(isLlmSdk('@github/copilot-sdk')).toBe(true)
  })

  it('does not match unrelated packages', () => {
    expect(isLlmSdk('zod')).toBe(false)
    expect(isLlmSdk('@google/other')).toBe(false)
    expect(isLlmSdk('openai-like')).toBe(false)
    expect(isLlmSdk('aimless')).toBe(false)
  })
})

describe('isMcpSdk', () => {
  it('matches the MCP SDK scope only', () => {
    expect(isMcpSdk('@modelcontextprotocol/sdk')).toBe(true)
    expect(isMcpSdk('@modelcontextprotocol/inspector')).toBe(true)
    expect(isMcpSdk('modelcontextprotocol')).toBe(false)
    expect(aiSdkKind('@modelcontextprotocol/sdk')).toBe('MCP SDK')
    expect(aiSdkKind('@anthropic-ai/sdk')).toBe('LLM SDK')
    expect(aiSdkKind('zod')).toBeUndefined()
  })
})

describe('checkManifests', () => {
  it('accepts the intended layout', () => {
    const violations = checkManifests([
      pkg('@coral/server', 'apps/server', { '@coral/brain': 'workspace:*' }),
      pkg('@coral/agent', 'apps/agent', { '@coral/shared': 'workspace:*' }),
      pkg('@coral/brain', 'packages/brain', { '@anthropic-ai/sdk': '^1.0.0' }),
      pkg('@coral/shared', 'packages/shared', { zod: '^4.0.0' }),
    ])
    expect(violations).toEqual([])
  })

  it('rejects an LLM SDK outside @coral/brain, including devDependencies', () => {
    const violations = checkManifests([pkg('@coral/agent', 'apps/agent', {}, { openai: '^5.0.0' })])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('LLM SDK "openai"')
  })

  it('lets only @coral/brain depend on the MCP SDK (§14.5)', () => {
    const violations = checkManifests([
      pkg('@coral/brain', 'packages/brain', { '@modelcontextprotocol/sdk': '^1.31.0' }),
      pkg('@coral/server', 'apps/server', { '@modelcontextprotocol/sdk': '^1.31.0' }),
      pkg('@coral/runner', 'packages/runner', {}, { '@modelcontextprotocol/sdk': '^1.31.0' }),
    ])
    expect(violations).toEqual([
      expect.stringContaining('@coral/server (dependencies) depends on MCP SDK'),
      expect.stringContaining('@coral/runner (devDependencies) depends on MCP SDK'),
    ])
  })

  it('rejects @coral/brain outside @coral/server', () => {
    const violations = checkManifests([
      pkg('@coral/agent', 'apps/agent', { '@coral/brain': 'workspace:*' }),
      pkg('@coral/cli', 'packages/cli', { '@coral/brain': 'workspace:*' }),
    ])
    expect(violations).toHaveLength(2)
  })

  it('keeps the runner free of @coral/brain and LLM SDKs (P1, D09)', () => {
    const violations = checkManifests([
      pkg('@coral/runner', 'packages/runner', { '@coral/brain': 'workspace:*' }, { openai: '^5' }),
    ])
    expect(violations).toHaveLength(2)
  })

  it('keeps Node-only packages out of the browser app', () => {
    const violations = checkManifests([
      pkg(
        '@coral/web',
        'apps/web',
        { '@coral/shared': 'workspace:*' },
        { '@coral/runner': 'workspace:*' },
      ),
      pkg('@coral/runner', 'packages/runner'),
      pkg('@coral/shared', 'packages/shared'),
    ])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('Node-only "@coral/runner"')
  })

  it('rejects an app depending on another app', () => {
    const violations = checkManifests([
      pkg('@coral/server', 'apps/server'),
      pkg('@coral/cli', 'packages/cli', { '@coral/server': 'workspace:*' }),
    ])
    expect(violations).toEqual([expect.stringContaining('depends on app "@coral/server"')])
  })
})

describe('checkLockfile', () => {
  const packages = [
    pkg('@coral/agent', 'apps/agent'),
    pkg('@coral/server', 'apps/server'),
    pkg('@coral/shared', 'packages/shared'),
    pkg('@coral/brain', 'packages/brain'),
  ]

  it('passes a clean graph', () => {
    const violations = checkLockfile(
      {
        importers: {
          'apps/agent': {
            dependencies: {
              '@coral/shared': { version: 'link:../../packages/shared' },
              pino: { version: '9.9.0' },
            },
          },
          'apps/server': {
            dependencies: { '@coral/brain': { version: 'link:../../packages/brain' } },
          },
          'packages/brain': { dependencies: { openai: { version: '5.0.0' } } },
          'packages/shared': { dependencies: { zod: { version: '4.1.5' } } },
        },
        snapshots: { 'pino@9.9.0': { dependencies: { 'atomic-sleep': '1.0.0' } } },
      },
      packages,
    )
    expect(violations).toEqual([])
  })

  it('finds @coral/brain reached through another workspace package', () => {
    const violations = checkLockfile(
      {
        importers: {
          'apps/agent': {
            dependencies: { '@coral/shared': { version: 'link:../../packages/shared' } },
          },
          'packages/shared': {
            dependencies: { '@coral/brain': { version: 'link:../brain' } },
          },
        },
      },
      packages,
    )
    expect(violations).toContain(
      '@coral/agent reaches @coral/brain: @coral/agent → @coral/shared → @coral/brain',
    )
  })

  it('finds an LLM SDK pulled in by a third-party package', () => {
    const violations = checkLockfile(
      {
        importers: { 'apps/agent': { dependencies: { 'some-helper': { version: '1.0.0' } } } },
        snapshots: {
          'some-helper@1.0.0': { dependencies: { '@anthropic-ai/sdk': '0.60.0' } },
        },
      },
      packages,
    )
    expect(violations).toEqual([
      '@coral/agent reaches LLM SDK "@anthropic-ai/sdk": @coral/agent → some-helper → @anthropic-ai/sdk',
    ])
  })
})

describe('checkLockfile (MCP)', () => {
  it('finds the MCP SDK reached by a runtime package through a workspace package', () => {
    const violations = checkLockfile(
      {
        importers: {
          'apps/agent': {
            dependencies: { '@coral/shared': { version: 'link:../../packages/shared' } },
          },
          'packages/shared': {
            dependencies: { '@modelcontextprotocol/sdk': { version: '1.31.0' } },
          },
        },
        snapshots: { '@modelcontextprotocol/sdk@1.31.0': {} },
      },
      [pkg('@coral/agent', 'apps/agent'), pkg('@coral/shared', 'packages/shared')],
    )
    expect(violations).toContain(
      '@coral/agent reaches MCP SDK "@modelcontextprotocol/sdk": @coral/agent → @coral/shared → @modelcontextprotocol/sdk',
    )
  })
})

describe('restrictedImports', () => {
  it('lists the MCP SDK with the LLM SDKs', () => {
    const { patterns } = restrictedImports({ llmSdks: true, brain: false, apps: [] })
    expect(patterns).toContainEqual({
      group: ['@modelcontextprotocol/*'],
      message: expect.stringContaining('MCP SDK') as string,
    })
  })

  it('restricts exact names and their subpaths', () => {
    const { paths, patterns } = restrictedImports({ llmSdks: false, brain: true, apps: [] })
    expect(paths.map((p) => p.name)).toEqual(['@coral/brain'])
    expect(patterns.map((p) => p.group)).toEqual([['@coral/brain/*']])
  })
})

describe('repository', () => {
  it('has no boundary violations', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    expect(runChecks(root)).toEqual([])
  })
})
