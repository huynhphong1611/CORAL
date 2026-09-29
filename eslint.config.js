// @ts-check
import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { NODE_ONLY_PACKAGES, restrictedImports } from './scripts/boundaries.mjs'

const APPS = ['@coral/server', '@coral/web', '@coral/agent']

/**
 * Adds extra forbidden modules to a restricted-imports option object.
 * @param {ReturnType<typeof restrictedImports>} options
 * @param {{ names: string[], groups: string[], message: string }} extra
 */
function withExtraRestrictions(options, extra) {
  return {
    paths: [...options.paths, ...extra.names.map((name) => ({ name, message: extra.message }))],
    patterns: [...options.patterns, { group: extra.groups, message: extra.message }],
  }
}

/** D28: the runner core is platform-neutral — no driver code, no processes, no sockets. */
const RUNNER_CORE = {
  names: ['node:child_process', 'child_process', 'node:net', 'net'],
  groups: ['**/drivers', '**/drivers/**'],
  message:
    'D28: the runner core only talks to UiDriver/TargetLifecycle; driver code lives in drivers/.',
}

/** The web app runs in the browser: no Node built-ins, no Node-only workspace packages. */
const BROWSER = {
  names: NODE_ONLY_PACKAGES,
  groups: ['node:*', ...NODE_ONLY_PACKAGES.map((name) => `${name}/*`)],
  message: 'apps/web runs in the browser: no node:* modules or Node-only packages (@coral/runner).',
}

/** Constitution V: HTTP routes reach the database only through tenant-scoped repositories. */
const ROUTES_NO_DB = {
  names: ['drizzle-orm', 'pg'],
  groups: ['**/db', '**/db/**', 'drizzle-orm/*'],
  message: 'Constitution V: routes use src/repos (tenant-scoped repositories), never the DB layer.',
}

export default defineConfig(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/.turbo/**', '**/coverage/**', '.specify/**'],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Fastify handlers are async by convention even when they do not await.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Plain JS and tool config files are linted without type information.
    files: ['**/*.{js,mjs,cjs}', '**/*.config.ts', 'vitest.shared.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // TanStack Router guards throw redirect() by design.
      '@typescript-eslint/only-throw-error': [
        'error',
        { allow: [{ from: 'package', package: '@tanstack/router-core', name: 'Redirect' }] },
      ],
    },
  },

  // --- Dependency boundaries (SPEC P1, D08); pnpm check:boundaries covers package.json + lockfile.
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        restrictedImports({ llmSdks: true, brain: true, apps: APPS }),
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        withExtraRestrictions(
          restrictedImports({ llmSdks: true, brain: true, apps: APPS }),
          BROWSER,
        ),
      ],
    },
  },
  {
    files: ['apps/server/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        restrictedImports({ llmSdks: true, brain: false, apps: APPS }),
      ],
    },
  },
  {
    files: ['packages/runner/src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        withExtraRestrictions(
          restrictedImports({ llmSdks: true, brain: true, apps: APPS }),
          RUNNER_CORE,
        ),
      ],
    },
  },
  {
    files: ['apps/server/src/routes/**/*.ts'],
    // Integration tests next to the routes may inspect the database they exercise.
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        withExtraRestrictions(
          restrictedImports({ llmSdks: true, brain: false, apps: APPS }),
          ROUTES_NO_DB,
        ),
      ],
    },
  },
  {
    files: ['packages/brain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        restrictedImports({ llmSdks: false, brain: false, apps: APPS }),
      ],
    },
  },

  prettier,
)
