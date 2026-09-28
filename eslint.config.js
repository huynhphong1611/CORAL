// @ts-check
import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { restrictedImports } from './scripts/boundaries.mjs'

const APPS = ['@coral/server', '@coral/web', '@coral/agent']

/**
 * Adds the D28 rules for `packages/runner/src/core/**` to a restricted-imports option object.
 * @param {ReturnType<typeof restrictedImports>} options
 */
function withRunnerCoreRules(options) {
  const message =
    'D28: the runner core only talks to UiDriver/TargetLifecycle; driver code lives in drivers/.'
  return {
    paths: [
      ...options.paths,
      ...['node:child_process', 'child_process', 'node:net', 'net'].map((name) => ({
        name,
        message,
      })),
    ],
    patterns: [...options.patterns, { group: ['**/drivers', '**/drivers/**'], message }],
  }
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
    files: ['apps/server/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        restrictedImports({ llmSdks: true, brain: false, apps: APPS }),
      ],
    },
  },
  {
    // D28: the runner core is platform-neutral — no driver code, no processes, no sockets.
    files: ['packages/runner/src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        withRunnerCoreRules(restrictedImports({ llmSdks: true, brain: true, apps: APPS })),
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
