// Test-only fixture loader (Vite resolves the globs at transform time; no Node APIs needed).
const load = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([path, text]) => [path.split('/').pop()!, text]))

export const validFixtures = load(
  import.meta.glob<string>('../../../../fixtures/testcases/valid/*.yaml', {
    eager: true,
    query: '?raw',
    import: 'default',
  }),
)
export const invalidFixtures = load(
  import.meta.glob<string>('../../../../fixtures/testcases/invalid/*.yaml', {
    eager: true,
    query: '?raw',
    import: 'default',
  }),
)
export const examples = load(
  import.meta.glob<string>('../../../../examples/*.yaml', {
    eager: true,
    query: '?raw',
    import: 'default',
  }),
)
