import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/main.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node24',
  // Workspace packages export TypeScript source, so they are bundled; npm deps stay external.
  deps: { alwaysBundle: [/^@coral\//] },
})
