import { walkTree } from '@coral/shared'
import { checkHit, expectFailure, extractLocators } from '@coral/runner'
import { androidTree, APP } from '@coral/runner/testing'
import { describe, expect, it } from 'vitest'

// The server uses the runner's pure functions (research R1): which elements take a tap, the
// locator chain of an element and whether an expectation holds on a stored tree — the same code
// the agent runs, so drafts written on the server behave the same at replay. Nothing here opens
// a driver or loads OpenCV.
describe('runner functions on the server', () => {
  const tree = androidTree('login')
  const ctx = { platform: 'android' as const, screen: { width: 1080, height: 2400 }, appId: APP }
  const button = [...walkTree(tree)].find((n) => n.platform_id.endsWith(':id/loginBtn'))

  it('finds the login button, its locators and that a tap reaches it', () => {
    if (!button) throw new Error('fixture has no loginBtn')
    const centre = {
      x: button.bounds.x + button.bounds.w / 2,
      y: button.bounds.y + button.bounds.h / 2,
    }
    expect(checkHit(tree, button, centre).ok).toBe(true)
    expect(extractLocators(button, tree, ctx)[0]).toEqual({ android_id: 'id/loginBtn' })
  })

  it('checks an expectation on a stored tree', () => {
    expect(expectFailure([{ visible: [{ android_id: 'id/loginBtn' }] }], tree, ctx)).toBeUndefined()
    expect(expectFailure([{ visible_text: 'no such text anywhere' }], tree, ctx)).toBeTypeOf(
      'string',
    )
  })
})
