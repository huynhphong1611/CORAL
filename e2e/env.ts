/** Ports of the E2E stack (playwright.config.ts starts both; fixtures talk to the server). */
export const PREVIEW_PORT = 4173
export const E2E_SERVER_PORT = Number(process.env.CORAL_E2E_SERVER_PORT ?? 3100)
export const E2E_SERVER_URL = `http://localhost:${E2E_SERVER_PORT}`
/** The fake OTP MCP server (US7): `pnpm mcp:otp`, its token a dev-only secret of the server. */
export const E2E_OTP_PORT = Number(process.env.CORAL_E2E_OTP_PORT ?? 3133)
export const E2E_OTP_URL = `http://127.0.0.1:${E2E_OTP_PORT}/mcp`
export const E2E_OTP_TOKEN = 'e2e-otp-token'
