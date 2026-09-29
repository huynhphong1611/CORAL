import { defineConfig, devices } from '@playwright/test'
import { E2E_SERVER_PORT, E2E_SERVER_URL, PREVIEW_PORT } from './e2e/env'

// Browser E2E (Phase 2, research R14): `e2e/*.e2e.ts`, run with `pnpm test:e2e`. Chromium comes
// from PLAYWRIGHT_BROWSERS_PATH (preinstalled in the dev container) or `playwright install
// chromium` in CI; PLAYWRIGHT_CHROMIUM points at another build when the versions differ.
// Needs the compose services up and migrated (like `pnpm test:int`).
const serverUrl = E2E_SERVER_URL
const executablePath = process.env.PLAYWRIGHT_CHROMIUM

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  outputDir: 'e2e-results/artifacts',
  // One device and one server per run: tests run one after another.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  reporter: [['list'], ['html', { outputFolder: 'e2e-results/report', open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PREVIEW_PORT}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    ...(executablePath && { launchOptions: { executablePath } }),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    // A real coral-server on its own port and data dir (the fixtures seed users and agents).
    {
      command: 'node --import tsx apps/server/src/main.ts',
      url: `${serverUrl}/health/ready`,
      env: {
        CORAL_SERVER_PORT: String(E2E_SERVER_PORT),
        CORAL_DATA_DIR: 'e2e-results/data',
        CORAL_LOG_LEVEL: 'warn',
      },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    // The built SPA, served the way a deployment would (vite preview keeps the /api proxy).
    {
      command: `pnpm --filter @coral/web build && pnpm --filter @coral/web exec vite preview --port ${PREVIEW_PORT} --strictPort`,
      url: `http://localhost:${PREVIEW_PORT}`,
      env: { CORAL_SERVER_URL: serverUrl },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
})
