import { describe, expect, it } from 'vitest'
import { APP, androidTree } from '../../testing/android-fixtures'
import { el, windows } from '../../testing/fake-driver'
import { pickTarget } from './pick'

const id = (name: string) => `${APP}:id/${name}`

describe('pickTarget (FR-011, research R8.1)', () => {
  it('gives the clickable element that receives the tap', () => {
    const login = androidTree('login')
    expect(pickTarget(login, { x: 540, y: 990 })?.platform_id).toBe(id('loginBtn'))
    expect(pickTarget(login, { x: 540, y: 550 })?.platform_id).toBe(id('nameET'))
  })

  it('gives the button for a click on the icon or text inside it', () => {
    // tab_icon is a non-clickable ImageView inside the clickable tab_menu.
    const target = pickTarget(androidTree('login'), { x: 675, y: 2300 })
    expect(target?.platform_id).toBe(id('tab_menu'))
    expect(target?.desc).toBe('Menu')
  })

  it('lets a click through a logo drawn over the menu button', () => {
    const tree = windows(
      APP,
      el({
        bounds: [0, 0, 1080, 2400],
        children: [
          el({ platform_id: id('menuIV'), clickable: true, bounds: [0, 100, 200, 200] }),
          el({
            platform_id: id('logo'),
            class: 'android.widget.ImageView',
            bounds: [50, 150, 400, 100],
            android: {
              password: false,
              focused: false,
              scrollable: false,
              drawing_order: 9,
              window_index: 0,
            },
          }),
        ],
      }),
    )
    expect(pickTarget(tree, { x: 100, y: 200 })?.platform_id).toBe(id('menuIV'))
    // Beside the menu only the logo is there: nothing clickable, so the window.
    expect(pickTarget(tree, { x: 350, y: 200 })?.ref).toBe('0')
  })

  it('finds a clickable child that sticks out of its non-clickable parent', () => {
    const tree = windows(
      APP,
      el({
        bounds: [0, 0, 1080, 2400],
        children: [
          el({
            bounds: [0, 0, 100, 100],
            children: [
              el({ platform_id: id('outer'), clickable: true, bounds: [0, 0, 600, 600] }),
              el({ platform_id: id('inner'), clickable: true, bounds: [200, 200, 200, 200] }),
            ],
          }),
        ],
      }),
    )
    // The smallest clickable node containing the point wins.
    expect(pickTarget(tree, { x: 300, y: 300 })?.platform_id).toBe(id('inner'))
    expect(pickTarget(tree, { x: 500, y: 500 })?.platform_id).toBe(id('outer'))
  })

  it('gives the window on top for a click outside the app', () => {
    const login = androidTree('login')
    const statusBar = pickTarget(login, { x: 600, y: 40 })
    expect(statusBar?.package_or_bundle).toBe('com.android.systemui')
    expect(login.some((w) => w.ref === statusBar?.ref)).toBe(true)

    // Outside a permission dialog: the dialog takes the touch (modal), not the app below it.
    const dialog = androidTree('permission-dialog')
    const outside = pickTarget(dialog, { x: 540, y: 300 })
    expect(outside?.package_or_bundle).toMatch(/permissioncontroller/)
    expect(dialog.some((w) => w.ref === outside?.ref)).toBe(true)
  })
})
