import { describe, expect, it } from 'vitest'
import {
  mergeRules,
  skillHeader,
  validateSkillRulesSource,
  validateSkillSource,
  type SkillRules,
} from './skill'

const skill = `---
name: login-demo-account
description: Đăng nhập My Demo App bằng tài khoản demo khi gặp màn Login
license: MIT
---
Mở menu → Log In. Username dùng secret TEST_USER.
`

describe('validateSkillSource', () => {
  it('reads name, description and the body', () => {
    const result = validateSkillSource(skill, 'login-demo-account')
    expect(result.errors).toEqual([])
    expect(result.value).toEqual({
      name: 'login-demo-account',
      description: 'Đăng nhập My Demo App bằng tài khoản demo khi gặp màn Login',
      body: 'Mở menu → Log In. Username dùng secret TEST_USER.\n',
    })
    expect(skillHeader(skill)?.name).toBe('login-demo-account')
  })

  it('reports problems on the line of the file', () => {
    const errors = (source: string, name?: string) =>
      validateSkillSource(source, name).errors.map((e) => [e.code, e.line, e.path])
    expect(errors(skill, 'other')).toEqual([['schema', 2, 'name']])
    expect(errors(skill.replace('description: Đăng', 'descr: Đăng'))).toEqual([
      ['schema', 2, 'description'],
    ])
    expect(errors(skill.replace('login-demo-account', 'Login Demo'))).toEqual([
      ['schema', 2, 'name'],
    ])
    expect(errors('no frontmatter')).toEqual([['schema', 1, '']])
    expect(skillHeader('no frontmatter')).toBeUndefined()
  })
})

describe('examples/skills/', () => {
  const files = import.meta.glob<string>('../../../../examples/skills/*/*', {
    eager: true,
    query: '?raw',
    import: 'default',
  })
  const file = (name: string) =>
    Object.entries(files).find(([path]) => path.endsWith(name))?.[1] ?? ''

  it('holds a valid skill and its rules', () => {
    const md = validateSkillSource(file('login-demo-account/SKILL.md'), 'login-demo-account')
    expect(md).toMatchObject({ valid: true, errors: [] })
    const rules = validateSkillRulesSource(file('login-demo-account/rules.yaml'))
    expect(rules).toMatchObject({ valid: true, errors: [] })
    expect(rules.value?.test_data).toEqual({
      username: '${secret:TEST_USER}',
      password: '${secret:TEST_PASSWORD}',
    })
  })
})

describe('rules.yaml', () => {
  const rules = `schema: coral/skill-rules@1
never_tap: ['Place Order']
forbidden:
  - { android_id: 'id/checkoutBtn' }
test_data:
  username: '\${secret:TEST_USER}'
  shipping_zip: '70000'
allow_submit:
  - { screen_text: 'Sign up' }
`

  it('reads the rules of a skill', () => {
    const result = validateSkillRulesSource(rules)
    expect(result.errors).toEqual([])
    expect(result.value?.test_data).toEqual({
      username: '${secret:TEST_USER}',
      shipping_zip: '70000',
    })
  })

  it('refuses image and point locators as forbidden elements', () => {
    const bad = rules.replace("{ android_id: 'id/checkoutBtn' }", '{ point_pct: [0.5, 0.5] }')
    expect(validateSkillRulesSource(bad).errors.map((e) => [e.code, e.line])).toEqual([
      ['schema', 4],
    ])
  })

  it('merges the rules of every skill, never_tap without duplicates', () => {
    const a = validateSkillRulesSource(rules).value as SkillRules
    const b: SkillRules = {
      schema: 'coral/skill-rules@1',
      never_tap: ['place  ORDER', 'Delete account'],
      forbidden: [{ text: 'Pay' }],
      test_data: { shipping_zip: '10000' },
      allow_submit: [],
    }
    expect(mergeRules([a, b])).toEqual({
      neverTap: ['place  ORDER', 'Delete account'],
      forbidden: [{ android_id: 'id/checkoutBtn' }, { text: 'Pay' }],
      testData: { username: '${secret:TEST_USER}', shipping_zip: '10000' },
      allowSubmit: [{ screen_text: 'Sign up' }],
    })
  })
})
