// SC-010 (T065): the replay path needs no AI. The run-time dependency closure of the runner, the
// agent and the CLI, read from pnpm-lock.yaml, holds no LLM SDK, no MCP SDK and not @coral/brain.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { isLlmSdk, runtimeClosure, type Lockfile, type WorkspacePackage } from './boundaries.mjs'
import { loadWorkspacePackages } from './check-boundaries.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const packages = loadWorkspacePackages(root)
const lockfile = parse(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')) as Lockfile

const isMcpSdk = (name: string) => name.startsWith('@modelcontextprotocol/')
const aiPackages = (closure: Set<string>) =>
  [...closure].filter((name) => isLlmSdk(name) || isMcpSdk(name) || name === '@coral/brain')

describe('SC-010: no AI on the replay path', () => {
  // A package each closure must contain, so an empty walk cannot pass by accident.
  const cases = [
    [
      '@coral/runner',
      ['@coral/shared', 'zod', 'fast-xml-parser', 'fast-png', '@techstark/opencv-js'],
    ],
    ['@coral/agent', ['@coral/runner', 'ws', 'pino', 'fast-xml-parser']],
    ['@coral/cli', ['@coral/runner', 'commander', 'yaml']],
  ] as const
  for (const [name, expected] of cases) {
    it(`${name} needs no LLM SDK, MCP SDK or @coral/brain at run time`, () => {
      const closure = runtimeClosure(lockfile, packages, name)
      for (const dep of expected) expect(closure).toContain(dep)
      expect(aiPackages(closure)).toEqual([])
    })
  }

  it('would see an MCP or LLM SDK deep in the closure', () => {
    const fake: WorkspacePackage[] = [
      { name: '@coral/agent', dir: 'apps/agent', manifest: {} },
      { name: '@coral/runner', dir: 'packages/runner', manifest: {} },
    ]
    const closure = runtimeClosure(
      {
        importers: {
          'apps/agent': { dependencies: { '@coral/runner': 'link:../../packages/runner' } },
          'packages/runner': { dependencies: { helper: { version: '1.0.0' } } },
        },
        snapshots: {
          'helper@1.0.0': {
            dependencies: { '@modelcontextprotocol/sdk': '1.2.0', llm: 'openai@5.0.0' },
          },
          '@modelcontextprotocol/sdk@1.2.0': {},
          'openai@5.0.0': {},
        },
      },
      fake,
      '@coral/agent',
    )
    expect(aiPackages(closure).sort()).toEqual(['@modelcontextprotocol/sdk', 'openai'])
  })
})
