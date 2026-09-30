/** Ports of the E2E stack (playwright.config.ts starts both; fixtures talk to the server). */
export const PREVIEW_PORT = 4173
export const E2E_SERVER_PORT = Number(process.env.CORAL_E2E_SERVER_PORT ?? 3100)
export const E2E_SERVER_URL = `http://localhost:${E2E_SERVER_PORT}`
