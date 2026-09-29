import { defineConfig, devices } from '@playwright/test'

// Browser E2E (Phase 2, research R14): `e2e/*.e2e.ts`, run with `pnpm test:e2e`. Chromium comes
// from PLAYWRIGHT_BROWSERS_PATH (preinstalled in the dev container) or `playwright install
// chromium` in CI; PLAYWRIGHT_CHROMIUM points at another build when the versions differ.
const PREVIEW_PORT = 4173
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
  // The built SPA, served the way a deployment would (vite preview keeps the /api proxy).
  webServer: {
    command: `pnpm --filter @coral/web build && pnpm --filter @coral/web exec vite preview --port ${PREVIEW_PORT} --strictPort`,
    url: `http://localhost:${PREVIEW_PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
