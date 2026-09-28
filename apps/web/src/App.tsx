import { useQuery } from '@tanstack/react-query'
import { fetchHealth } from './api'

export function App() {
  const health = useQuery({ queryKey: ['health'], queryFn: () => fetchHealth(), retry: false })

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', margin: '3rem auto', maxWidth: 640 }}>
      <h1>coral</h1>
      <p>Tests that grow back. Phase 0 skeleton — screens arrive in Phase 2.</p>
      <section aria-live="polite">
        <h2>coral-server</h2>
        {health.isPending && <p>Checking…</p>}
        {health.isError && <p role="alert">Unreachable: {health.error.message}</p>}
        {health.isSuccess && (
          <p>
            OK — version {health.data.version}, up {health.data.uptime_sec.toFixed(1)} s
          </p>
        )}
      </section>
    </main>
  )
}
