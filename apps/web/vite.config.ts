import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const serverUrl = process.env.CORAL_SERVER_URL ?? 'http://localhost:3000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // The SPA calls /api/* (REST and WS /api/ws/ui); in development Vite forwards it to
    // coral-server without the prefix. The refresh cookie is set for Path=/auth by the server, so
    // its path is rewritten to /api/auth for the browser to send it back (research R2).
    proxy: {
      '/api': {
        target: serverUrl,
        changeOrigin: true,
        ws: true,
        cookiePathRewrite: { '/auth': '/api/auth' },
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
