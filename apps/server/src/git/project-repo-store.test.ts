import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId } from '@coral/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProjectRepoStore } from './project-repo-store'

let root = ''
let store: ProjectRepoStore
const tenant = newId()
const project = newId()
const huynh = { name: 'Huynh', email: 'huynh@example.com' }

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'coral-git-'))
  store = new ProjectRepoStore(root)
})
afterAll(() => rm(root, { recursive: true, force: true }))

describe('ProjectRepoStore', () => {
  it('initializes the repo under repos/<tenant>/<project> with a first commit', async () => {
    const sha = await store.init(tenant, project, {
      files: { 'popups.yaml': 'schema: coral/popups@1\n', 'README.md': '# demo\n' },
      author: huynh,
    })
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(store.repoPath(tenant, project)).toBe(join(root, 'repos', tenant, project))
    expect(await store.readFile(tenant, project, 'README.md')).toBe('# demo\n')
  })

  it('commits each write and reads any version back', async () => {
    const path = 'testcases/login.yaml'
    const v1 = await store.writeFile(tenant, project, {
      path,
      content: 'v1\n',
      author: huynh,
      message: 'testcase: login',
    })
    const v2 = await store.writeFile(tenant, project, {
      path,
      content: 'v2\n',
      author: { name: 'Reviewer', email: 'r@example.com' },
      message: 'testcase: login',
    })
    expect(v2).not.toBe(v1)
    expect(await store.readFile(tenant, project, path)).toBe('v2\n')
    expect(await store.readFile(tenant, project, path, v1)).toBe('v1\n')
    expect(await store.readFile(tenant, project, 'testcases/nope.yaml', v1)).toBeNull()

    const history = await store.history(tenant, project, path)
    expect(history.map((h) => h.commit)).toEqual([v2, v1])
    expect(history[1]).toMatchObject({ author: huynh, message: 'testcase: login' })
    expect(history[0]?.createdAt).toBeInstanceOf(Date)
  })

  it('returns HEAD without a new commit when content is unchanged', async () => {
    const input = {
      path: 'popups.yaml',
      content: 'schema: coral/popups@1\n',
      author: huynh,
      message: 'popups: update',
    }
    const before = await store.history(tenant, project, 'popups.yaml')
    const sha = await store.writeFile(tenant, project, input)
    expect(await store.history(tenant, project, 'popups.yaml')).toHaveLength(before.length)
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('serializes concurrent writes to the same project', async () => {
    const writes = Array.from({ length: 8 }, (_, i) =>
      store.writeFile(tenant, project, {
        path: `testcases/c${i}.yaml`,
        content: `${i}\n`,
        author: huynh,
        message: `testcase: c${i}`,
      }),
    )
    const shas = await Promise.all(writes)
    expect(new Set(shas).size).toBe(8)
    for (let i = 0; i < 8; i++) {
      expect(await store.readFile(tenant, project, `testcases/c${i}.yaml`)).toBe(`${i}\n`)
    }
  })

  it('rejects unsafe paths and ids', async () => {
    const bad = (path: string) =>
      store.writeFile(tenant, project, { path, content: 'x', author: huynh, message: 'x' })
    await expect(bad('../escape.yaml')).rejects.toThrow('unsafe')
    await expect(bad('/etc/passwd')).rejects.toThrow('unsafe')
    await expect(bad('.git/config')).rejects.toThrow('unsafe')
    expect(() => store.repoPath('../x', project)).toThrow()
    await expect(store.readFile(tenant, project, 'README.md', 'HEAD~1; rm')).rejects.toThrow(
      'invalid commit',
    )
  })

  it('commits files and binary snapshots in one commit, replacing a whole directory', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255])
    const first = await store.commitFiles(tenant, project, {
      files: {
        'testcases/rec.yaml': 'v1\n',
        'snap/rec/s1/element.png': png,
        'snap/rec/s2/tree.json': '[]',
      },
      author: huynh,
      message: 'testcase: rec (recorder)',
    })
    expect(await store.readBytes(tenant, project, 'snap/rec/s1/element.png', first)).toEqual(
      Buffer.from(png),
    )
    expect(await store.listFiles(tenant, project, 'snap/rec', first)).toEqual([
      'snap/rec/s1/element.png',
      'snap/rec/s2/tree.json',
    ])
    const history = await store.history(tenant, project, 'snap/rec/s1/element.png')
    expect(history.map((v) => v.commit)).toEqual([first])

    // Re-recorded: the old folder goes, the new one comes, the YAML changes — one commit.
    const second = await store.commitFiles(tenant, project, {
      files: { 'testcases/rec.yaml': 'v2\n', 'snap/rec/s3/screen.jpg': png },
      removeDirs: ['snap/rec'],
      author: huynh,
      message: 'testcase: rec (recorder)',
    })
    expect(await store.listFiles(tenant, project, 'snap/rec', second)).toEqual([
      'snap/rec/s3/screen.jpg',
    ])
    expect(await store.readFile(tenant, project, 'testcases/rec.yaml', second)).toBe('v2\n')
    expect(await store.history(tenant, project, 'testcases/rec.yaml')).toHaveLength(2)
    // Nothing changed: no new commit.
    expect(
      await store.commitFiles(tenant, project, {
        files: { 'testcases/rec.yaml': 'v2\n' },
        author: huynh,
        message: 'same',
      }),
    ).toBe(second)
    await expect(
      store.commitFiles(tenant, project, {
        files: {},
        removeDirs: ['../x'],
        author: huynh,
        message: 'x',
      }),
    ).rejects.toThrow('unsafe repository path')
  })
})
