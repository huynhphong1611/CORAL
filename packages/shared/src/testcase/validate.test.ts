import { describe, expect, it } from 'vitest'
import expected from '../../../../fixtures/testcases/invalid/expected.json' with { type: 'json' }
import { examples, fixtureRepoFiles, invalidFixtures, validFixtures } from '../testing/fixtures'
import { imagePaths, isValidImagePath, validateTestCase, validateTestCaseSource } from './validate'

// fixtures/testcases/ plays the project repo: image locators must point at files there.
const repo = { fileExists: (path: string) => fixtureRepoFiles.has(path) }

describe('validateTestCaseSource', () => {
  it('loads every fixture', () => {
    expect(Object.keys(validFixtures).length).toBeGreaterThanOrEqual(2)
    expect(Object.keys(invalidFixtures).sort()).toEqual(Object.keys(expected).sort())
  })

  it.each(Object.entries(validFixtures))('passes %s without errors', (name, source) => {
    const result = validateTestCaseSource(source, name, repo)
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
    expect(result.value?.steps.length).toBeGreaterThan(0)
  })

  // SC-006: every invalid fixture reports exactly the expected errors, with a source position.
  it.each(Object.entries(expected))('reports %s', (name, wanted) => {
    const result = validateTestCaseSource(invalidFixtures[name] ?? '', name, repo)
    expect(result.valid).toBe(false)
    expect(result.errors.map(({ code, step_id, path }) => ({ code, step_id, path }))).toEqual(
      wanted.map((w) => ({ step_id: undefined, ...w })),
    )
    for (const error of result.errors) {
      expect(error.file).toBe(name)
      expect(error.line).toBeGreaterThan(0)
      expect(error.column).toBeGreaterThan(0)
    }
  })

  it('points at the offending line', () => {
    const result = validateTestCaseSource(invalidFixtures['point-pct-not-last.yaml'] ?? '', 'f')
    expect(result.errors[0]).toMatchObject({ line: 9, column: 9 })
  })

  it('passes examples/testcase.example.yaml (ROADMAP: examples must validate)', () => {
    const result = validateTestCaseSource(examples['testcase.example.yaml'] ?? '', 'example')
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('warns about a tap without expect unless an assert follows', () => {
    const tc = (steps: unknown[]) => ({
      schema: 'coral/testcase@1',
      id: 'warn',
      intent: 'x',
      platforms: ['android'],
      steps,
    })
    const tap = { id: 't', action: 'tap', target: [{ text: 'Go' }] }
    const lonely = validateTestCase(tc([tap, { id: 'b', action: 'back' }]))
    expect(lonely.valid).toBe(true)
    expect(lonely.warnings).toMatchObject([
      { code: 'no_expect_after_tap', step_id: 't', path: 'steps[0]' },
    ])
    const followed = validateTestCase(
      tc([tap, { id: 'a', action: 'assert', expect: { visible_text: 'Done' } }]),
    )
    expect(followed.warnings).toEqual([])
  })

  it('checks coverage and interpolation inside expect and nested locators', () => {
    const result = validateTestCase({
      schema: 'coral/testcase@1',
      id: 'nested',
      intent: 'x',
      platforms: ['android', 'ios'],
      variables: { user: '${secret:TEST_USER}' },
      steps: [
        {
          id: 's1',
          action: 'launch',
          expect: [
            { visible: { android_id: 'id/a' } },
            { visible_text: 'Hi ${var:user} ${var:nope}' },
          ],
        },
        {
          id: 's2',
          action: 'tap',
          target: [{ rel: { below: { image: '../x.png' } } }],
          expect: { screen: 'home' },
        },
      ],
    })
    expect(result.errors.map((e) => [e.code, e.path])).toEqual([
      ['var_undeclared', 'steps[0].expect[1].visible_text'],
      ['platform_coverage', 'steps[0].expect[0].visible'],
      ['image_path_invalid', 'steps[1].target[0].rel.below.image'],
      ['unsupported_in_phase', 'steps[1].expect[0].screen'],
    ])
  })

  it('reports YAML syntax errors with a position', () => {
    const result = validateTestCaseSource('schema: [\n', 'broken.yaml')
    expect(result.errors[0]).toMatchObject({ code: 'yaml', file: 'broken.yaml' })
    expect(result.errors[0]?.line).toBeGreaterThan(0)
  })
})

describe('image locators (contracts/testcase-image-locator.md)', () => {
  it('lists the images a test case needs, short and long form', () => {
    const result = validateTestCaseSource(validFixtures['image-locator.yaml'] ?? '', 'x', repo)
    expect(result.value && imagePaths(result.value)).toEqual([
      'snap/image-locator/s2/element.png',
      'snap/image-locator/s3/element.png',
    ])
    expect(fixtureRepoFiles.has('snap/image-locator/s2/element.png')).toBe(true)
  })

  it('checks existence only when it knows the repo', () => {
    const source = invalidFixtures['image-not-found.yaml'] ?? ''
    expect(validateTestCaseSource(source, 'x').valid).toBe(true)
    expect(validateTestCaseSource(source, 'x', { fileExists: () => true }).valid).toBe(true)
  })

  it('accepts only .png paths inside the repo', () => {
    for (const ok of ['snap/a/s1/element.png', 'images/Logo.PNG', 'a.png']) {
      expect(isValidImagePath(ok), ok).toBe(true)
    }
    for (const bad of [
      '/abs/x.png',
      '../x.png',
      'snap/../../x.png',
      'snap//x.png',
      'C:/x.png',
      'snap\\x.png',
      'x.jpg',
      'snap/',
    ]) {
      expect(isValidImagePath(bad), bad).toBe(false)
    }
  })

  it('bounds the threshold and screen width of the long form', () => {
    const tc = (image: unknown) => ({
      schema: 'coral/testcase@1',
      id: 'img',
      intent: 'x',
      platforms: ['android'],
      steps: [{ id: 's1', action: 'tap', target: [{ image }], expect: { visible_text: 'y' } }],
    })
    expect(validateTestCase(tc({ path: 'a.png', threshold: 0.4 })).errors[0]?.code).toBe('schema')
    expect(validateTestCase(tc({ path: 'a.png', threshold: 1.1 })).errors[0]?.code).toBe('schema')
    expect(validateTestCase(tc({ path: 'a.png', screen_width: 0 })).errors[0]?.code).toBe('schema')
    expect(validateTestCase(tc({ path: 'a.png', extra: 1 })).errors[0]?.code).toBe('schema')
    expect(validateTestCase(tc({ path: 'a.png', threshold: 0.5, screen_width: 1080 })).valid).toBe(
      true,
    )
  })
})
