/**
 * The fake OTP MCP server (US7, SC-003) on its own: `pnpm mcp:otp [--port 3333] [--code 482913]
 * [--token T]`. Streamable HTTP at http://127.0.0.1:<port>/mcp; `get_otp` (read-only),
 * `send_sms` (side effect), `delete_user`. The server itself lives with the MCP SDK in
 * packages/brain (only the brain layer may depend on it, SPEC P1).
 */
import { parseArgs } from 'node:util'
import { startOtpServer } from '../../packages/brain/src/testing/otp-server'

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '3333' },
    code: { type: 'string' },
    token: { type: 'string' },
  },
})
const server = await startOtpServer({
  port: Number(values.port),
  ...(values.code ? { code: values.code } : {}),
  ...(values.token ? { token: values.token } : {}),
})
console.log(`fake OTP MCP server at ${server.url}`)
const stop = () => void server.close().then(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
