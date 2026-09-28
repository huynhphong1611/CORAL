import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const serverUrl = process.env.CORAL_SERVER_URL ?? 'http://localhost:3000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The SPA calls /api/*; in development Vite forwards it to coral-server.
    proxy: {
      '/api': {
        target: serverUrl,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
