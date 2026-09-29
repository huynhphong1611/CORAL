import { QueryClient } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiClient } from './api/client'
import { SessionStore } from './api/session'
import { UiSocket, uiSocketUrl } from './api/ws'
import { App } from './App'
import { createAppRouter } from './router'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root element')

const session = new SessionStore()
const client = new ApiClient({ onSession: (s) => session.set(s) })
const socket = new UiSocket({ url: uiSocketUrl(window.location), token: () => client.accessToken })
// One socket per tab: open while signed in, re-authenticated after every refresh.
session.subscribe(() => {
  if (session.signedIn) socket.renew()
  else socket.close()
})
void client.refresh()

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})
const context = { client, session, socket, queryClient }
const router = createAppRouter(context)

createRoot(container).render(
  <StrictMode>
    <App router={router} context={context} />
  </StrictMode>,
)
