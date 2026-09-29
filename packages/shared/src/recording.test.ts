import { describe, expect, it } from 'vitest'
import { parseYaml } from './testcase/parse'
import { recordingToYaml, snapshotPath, type RecordingStep } from './recording'

const step = (
  n: number,
  s: RecordingStep['step'],
): Pick<RecordingStep, 'step'> & { n: number } => ({ n, step: s })

/** The DoD flow of US4: launch, menu, Log In, user name, password (secret), Login. */
const steps = [
  step(1, { id: 's1', action: 'launch', expect: [{ visible_text: 'Products' }] }),
  step(2, {
    id: 's2',
    action: 'tap',
    target: [
      { android_id: 'id/menuIV' },
      { desc: 'View menu' },
      { image: { path: 'snap/recording-1/s2/element.png', screen_width: 1080 } },
    ],
    expect: [{ visible_text: 'Log In' }],
  }),
  step(3, {
    id: 's3',
    action: 'tap',
    target: [{ text: 'Log In' }, { image: 'snap/recording-1/s3/element.png' }],
    expect: [{ visible_text: 'Login' }],
  }),
  step(4, {
    id: 's4',
    action: 'type',
    target: [{ android_id: 'id/nameET' }, { image: 'snap/recording-1/s4/element.png' }],
    value: 'bod@example.com',
  }),
  step(5, {
    id: 's5',
    action: 'type',
    target: [{ android_id: 'id/passwordET' }, { image: 'snap/recording-1/s5/element.png' }],
    value: '${secret:TEST_PASSWORD}',
  }),
  step(6, {
    id: 's6',
    action: 'tap',
    target: [{ android_id: 'id/loginBtn' }, { image: 'snap/recording-1/s6/element.png' }],
  }),
]

describe('recordingToYaml (FR-017, data-model §3–4)', () => {
  it('writes a valid coral/testcase@1 with images under snap/<slug>/', () => {
    const { yaml, validation } = recordingToYaml(
      { slug: 'recorded-login', intent: 'Đăng nhập bằng tài khoản mẫu', steps },
      { fileExists: () => true },
    )
    expect(validation.errors).toEqual([])
    expect(validation.valid).toBe(true)
    const doc = parseYaml(yaml).value as Record<string, unknown>
    expect(doc).toMatchObject({
      schema: 'coral/testcase@1',
      id: 'recorded-login',
      intent: 'Đăng nhập bằng tài khoản mẫu',
      platforms: ['android'],
      preconditions: { app_state: 'fresh' },
    })
    expect(yaml).toContain('path: snap/recorded-login/s2/element.png')
    expect(yaml).toContain('image: snap/recorded-login/s6/element.png')
    expect(yaml).not.toContain('recording-1')
    // The last tap has no expect: a warning, not an error (FR-013a).
    expect(validation.warnings.map((w) => [w.code, w.step_id])).toEqual([
      ['no_expect_after_tap', 's6'],
    ])
  })

  it('keeps secrets as references, never values (FR-014)', () => {
    const { yaml } = recordingToYaml({ slug: 'recorded-login', intent: 'x', steps })
    expect(yaml).toContain('${secret:TEST_PASSWORD}')
  })

  it('follows a slug change and leaves images the Recorder did not write alone', () => {
    const custom = [
      step(1, {
        id: 's1',
        action: 'tap',
        target: [{ image: 'images/logo.png' }, { image: 'snap/old/s1/element.png' }],
        expect: [{ visible_text: 'x' }],
      }),
    ]
    const { yaml } = recordingToYaml({ slug: 'new-name', intent: 'x', steps: custom })
    expect(yaml).toContain('image: images/logo.png')
    expect(yaml).toContain('image: snap/new-name/s1/element.png')
    expect(snapshotPath('new-name', 's1', 'tree.json')).toBe('snap/new-name/s1/tree.json')
  })

  it('reports images missing from the repo when told which files exist', () => {
    const { validation } = recordingToYaml(
      { slug: 'recorded-login', intent: 'x', steps },
      { fileExists: (path) => !path.endsWith('s5/element.png') },
    )
    expect(validation.errors.map((e) => [e.code, e.step_id])).toEqual([['image_not_found', 's5']])
  })
})
