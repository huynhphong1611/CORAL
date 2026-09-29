import { describe, expect, it } from 'vitest'
import type { ElementNode } from '../element'
import { DEFAULT_POPUPS_YAML } from './default'
import { decidePopup, ruleMatches } from './match'
import { popupsSchema, type Popups } from './schema'
import { parseYaml } from '../testcase/parse'

let refs = 0
const node = (spec: Partial<ElementNode>, children: ElementNode[] = []): ElementNode => ({
  ref: String(refs++),
  platform_id: '',
  text: '',
  desc: '',
  class: 'android.widget.TextView',
  bounds: { x: 0, y: 0, w: 100, h: 50 },
  clickable: false,
  enabled: true,
  visible: true,
  package_or_bundle: 'com.example.app',
  children,
  ...spec,
})

const defaults: Popups = popupsSchema.parse(parseYaml(DEFAULT_POPUPS_YAML).value)
const PKG = 'com.google.android.permissioncontroller'
const permission = [
  node({ package_or_bundle: PKG, class: 'android.widget.FrameLayout' }, [
    node({ package_or_bundle: PKG, text: 'Allow My Demo App to take pictures and record video?' }),
    node({
      package_or_bundle: PKG,
      text: 'While using the app',
      class: 'android.widget.Button',
      clickable: true,
    }),
    node({
      package_or_bundle: PKG,
      text: 'Only this time',
      class: 'android.widget.Button',
      clickable: true,
    }),
    node({
      package_or_bundle: PKG,
      text: 'Don’t allow',
      class: 'android.widget.Button',
      clickable: true,
    }),
  ]),
]
const dialog = (title: string, buttons: string[]) => [
  node({ platform_id: 'android:id/parentPanel', class: 'android.widget.LinearLayout' }, [
    node({ platform_id: 'android:id/alertTitle', text: title }),
    ...buttons.map((b) => node({ text: b, class: 'android.widget.Button', clickable: true })),
  ]),
]

describe('popup rules', () => {
  it('matches the permission dialog of any permission package (default rules)', () => {
    const decision = decidePopup(defaults, permission)
    expect(decision).toMatchObject({
      kind: 'tap',
      rule: 'android_permission',
      button: 'While using the app',
    })
    expect(decision.kind === 'tap' && decision.node.text).toBe('While using the app')
  })

  it('needs every match key, text matching is case-insensitive and whitespace-normalised', () => {
    const rule = {
      name: 'r',
      match: { package: 'com.example.app', text_contains: '  ĐÁNH  giá ' },
      tap_any: ['Để sau'],
    }
    expect(ruleMatches(rule, dialog('Đánh giá ứng dụng?', ['Để sau']))).toBe(true)
    expect(
      ruleMatches(
        { ...rule, match: { ...rule.match, package: 'other.pkg' } },
        dialog('Đánh giá ứng dụng?', []),
      ),
    ).toBe(false)
    expect(
      ruleMatches(
        { name: 'id', match: { resource_id: 'android:id/parentPanel' }, tap_any: ['x'] },
        dialog('t', []),
      ),
    ).toBe(true)
    expect(
      ruleMatches(
        { name: 'id', match: { resource_id: 'id/alertTitle' }, tap_any: ['x'] },
        dialog('t', []),
      ),
    ).toBe(true)
  })

  it('takes tap_any in order and skips buttons that are not on screen', () => {
    const decision = decidePopup(
      defaults,
      dialog('Đánh giá ứng dụng?', ['Đánh giá ngay', 'Để sau']),
    )
    expect(decision).toMatchObject({ kind: 'tap', rule: 'rate_app', button: 'Để sau' })
  })

  it('never taps a never_tap button, even when a rule lists it', () => {
    const popups: Popups = {
      schema: 'coral/popups@1',
      rules: [{ name: 'shop', match: { text_contains: 'đơn hàng' }, tap_any: ['Thanh toán'] }],
      never_tap: ['thanh   TOÁN'],
    }
    expect(decidePopup(popups, dialog('Xác nhận đơn hàng', ['Mua', 'Thanh toán']))).toEqual({
      kind: 'blocked',
      rule: 'shop',
      reason: 'no allowed button of the rule is on screen',
    })
  })

  it('reports popups no rule knows', () => {
    expect(decidePopup(defaults, dialog('Xác nhận đơn hàng', ['Mua', 'Thanh toán']))).toEqual({
      kind: 'unknown',
    })
  })
})
