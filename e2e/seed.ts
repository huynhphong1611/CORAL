import { randomBytes } from 'node:crypto'
import { E2E_SERVER_URL } from './env'
import { api, expect } from './fixtures'

/**
 * A 10-step test case for the drawn My Demo App (scripts/dev-fake-device.ts): menu, catalog,
 * login with the demo account, menu again.
 */
export const TOUR = `schema: coral/testcase@1
id: tour
intent: 'Browse the menu, log in with the demo account and open the menu again'
platforms: [android]
variables:
  username: \${secret:TEST_USER}
  password: \${secret:TEST_PASSWORD}
steps:
  - id: open
    action: launch
    expect: { visible_text: 'Products', timeout_ms: 15000 }
  - id: menu
    action: tap
    target: [{ android_id: 'id/menuIV' }]
    expect: { visible_text: 'Log In' }
  - id: catalog
    action: tap
    target: [{ text: 'Catalog' }]
    expect: { visible_text: 'Products' }
  - id: menu-again
    action: tap
    target: [{ android_id: 'id/menuIV' }]
    expect: { visible_text: 'Log In' }
  - id: login-page
    action: tap
    target: [{ text: 'Log In' }]
    expect: { visible: [{ android_id: 'id/nameET' }] }
  - id: username
    action: type
    target: [{ android_id: 'id/nameET' }]
    value: \${var:username}
  - id: password
    action: type
    target: [{ android_id: 'id/passwordET' }]
    value: \${var:password}
  - id: keyboard
    action: hide_keyboard
  - id: submit
    action: tap
    target: [{ android_id: 'id/loginBtn' }]
    expect: { visible_text: 'Products' }
  - id: menu-last
    action: tap
    target: [{ android_id: 'id/menuIV' }]
    expect: { visible_text: 'QR Code Scanner' }
`

/** A project with the My Demo App, a build of it and the TOUR test case. */
export async function seedProject(
  token: string,
): Promise<{ projectId: string; buildId: string; testCaseId: string }> {
  const project = await api<{ id: string }>('/projects', {
    method: 'POST',
    token,
    body: { name: `Shop ${randomBytes(2).toString('hex')}` },
  })
  const app = await api<{ id: string }>(`/projects/${project.id}/apps`, {
    method: 'POST',
    token,
    body: {
      platform: 'android',
      package_or_bundle_id: 'com.saucelabs.mydemoapp.android',
      name: 'My Demo App',
    },
  })
  const form = new FormData()
  form.set('version', '2.2.0')
  form.set('file', new Blob([randomBytes(4096)]), 'mydemo.apk')
  const upload = await fetch(`${E2E_SERVER_URL}/apps/${app.id}/builds`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  })
  expect(upload.status).toBe(201)
  const build = (await upload.json()) as { id: string }
  const testCase = await api<{ id: string }>(`/projects/${project.id}/testcases`, {
    method: 'POST',
    token,
    body: { yaml: TOUR },
  })
  return { projectId: project.id, buildId: build.id, testCaseId: testCase.id }
}
