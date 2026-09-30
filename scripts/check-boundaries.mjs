#!/usr/bin/env node
// @ts-check
/** Enforces SPEC P1 / D08 dependency boundaries. Usage: pnpm check:boundaries */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { checkLockfile, checkManifests } from './boundaries.mjs'

/** @typedef {import('./boundaries.mjs').WorkspacePackage} WorkspacePackage */

/**
 * Lists workspace packages from pnpm-workspace.yaml (supports "dir/*" globs and plain dirs).
 * @param {string} root
 * @returns {WorkspacePackage[]}
 */
export function loadWorkspacePackages(root) {
  /** @type {{ packages?: string[] }} */
  const workspace = parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')) ?? {}
  /** @type {string[]} */
  const dirs = []
  for (const glob of workspace.packages ?? []) {
    if (glob.endsWith('/*')) {
      const parent = glob.slice(0, -2)
      if (!existsSync(join(root, parent))) continue
      for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(`${parent}/${entry.name}`)
      }
    } else {
      dirs.push(glob)
    }
  }
  return dirs
    .filter((dir) => existsSync(join(root, dir, 'package.json')))
    .map((dir) => {
      /** @type {WorkspacePackage['manifest'] & { name?: string }} */
      const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))
      return { name: String(manifest.name ?? dir), dir, manifest }
    })
}

/**
 * @param {string} root
 * @returns {string[]}
 */
export function runChecks(root) {
  const packages = loadWorkspacePackages(root)
  const violations = checkManifests(packages)
  const lockPath = join(root, 'pnpm-lock.yaml')
  if (existsSync(lockPath)) {
    violations.push(...checkLockfile(parse(readFileSync(lockPath, 'utf8')) ?? {}, packages))
  }
  return violations
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const violations = runChecks(root)
  if (violations.length > 0) {
    console.error(
      `Dependency boundary violations (SPEC P1, D08):\n  - ${violations.join('\n  - ')}`,
    )
    process.exit(1)
  }
  console.log('Dependency boundaries OK (SPEC P1, D08).')
}
