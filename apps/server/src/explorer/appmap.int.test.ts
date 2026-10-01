import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appMapSchema, newId } from '@coral/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProjectRepoStore } from '../git/project-repo-store'
import { APPMAP_PATH, commitAppMap, type SeenScreen } from './appmap'

let dir = ''
let store: ProjectRepoStore
const tenantId = newId()
const projectId = newId()
const author = { name: 'coral', email: 'coral@localhost' }
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'coral-appmap-'))
  store = new ProjectRepoStore(dir)
  await store.init(tenantId, projectId, { files: { 'README.md': '# shop\n' }, author })
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const screen = (c: string, name: string): SeenScreen => ({
  fingerprint: c.repeat(16),
  id: '',
  name,
  package: 'com.saucelabs.mydemoapp.android',
  firstSeenAt: new Date(),
  snapshot: { screen: JPEG, tree: '[]' },
})

describe('commitAppMap (T031)', () => {
  it('commits the merged map with pictures of new screens, and two explorations never overwrite each other', async () => {
    const [one, two] = await Promise.all([
      commitAppMap(store, {
        tenantId,
        projectId,
        explorationId: 'e1',
        screens: [screen('a', 'Catalog'), screen('b', 'Menu')],
        transitions: [],
        author,
      }),
      commitAppMap(store, {
        tenantId,
        projectId,
        explorationId: 'e2',
        screens: [screen('a', 'Catalog'), screen('c', 'Login')],
        transitions: [],
        author,
      }),
    ])
    expect(one.commit).not.toBeNull()
    expect(two.commit).not.toBe(one.commit)
    const map = appMapSchema.parse(
      JSON.parse((await store.readFile(tenantId, projectId, APPMAP_PATH)) ?? ''),
    )
    expect(map.screens.map((s) => [s.id, s.seen_in])).toEqual([
      ['catalog', ['e1', 'e2']],
      ['menu', ['e1']],
      ['login', ['e2']],
    ])
    expect(await store.readFile(tenantId, projectId, 'appmap/snap/login/tree.json')).toBe('[]')
    expect(await store.readBytes(tenantId, projectId, 'appmap/snap/catalog/screen.jpg')).toEqual(
      Buffer.from(JPEG),
    )
    const history = await store.history(tenantId, projectId, APPMAP_PATH)
    expect(history).toHaveLength(2)
  })

  it('makes no commit for an exploration that saw nothing', async () => {
    const result = await commitAppMap(store, {
      tenantId,
      projectId,
      explorationId: 'e3',
      screens: [],
      transitions: [],
      author,
    })
    expect(result.commit).toBeNull()
  })
})
