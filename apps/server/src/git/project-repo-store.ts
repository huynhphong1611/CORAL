import { mkdir, readFile as readFs, writeFile as writeFs } from 'node:fs/promises'
import { dirname, join, normalize, posix } from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'
import { z } from 'zod'

export interface GitAuthor {
  name: string
  email: string
}

export interface FileVersion {
  commit: string
  author: GitAuthor
  message: string
  createdAt: Date
}

export interface WriteInput {
  path: string
  content: string
  author: GitAuthor
  message: string
}

const uuid = z.uuid()
const SYSTEM_COMMITTER: GitAuthor = { name: 'coral', email: 'coral@localhost' }

/** Repo-relative POSIX path with no escape (`..`), absolute form or `.git` access. */
function safePath(path: string): string {
  const clean = posix.normalize(path)
  if (
    clean.startsWith('/') ||
    clean === '.' ||
    clean.split('/').some((part) => part === '..' || part === '.git') ||
    clean.includes('\\')
  ) {
    throw new Error(`unsafe repository path: ${path}`)
  }
  return clean
}

/**
 * One git repository with a working tree per project (research R8, D15), owned by the server.
 * Writes to the same project are serialized; each write is one commit.
 */
export class ProjectRepoStore {
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(private readonly rootDir: string) {}

  repoPath(tenantId: string, projectId: string): string {
    return normalize(join(this.rootDir, 'repos', uuid.parse(tenantId), uuid.parse(projectId)))
  }

  private git(dir: string): SimpleGit {
    // Minimal environment: HOME points at the data dir so the host's ~/.gitconfig is ignored;
    // the committer comes from the repo-local config written by init().
    return simpleGit({ baseDir: dir }).env({
      PATH: process.env.PATH ?? '',
      HOME: this.rootDir,
    })
  }

  private withLock<T>(dir: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(dir) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    const tail = next.catch(() => undefined)
    this.locks.set(dir, tail)
    void tail.then(() => {
      if (this.locks.get(dir) === tail) this.locks.delete(dir)
    })
    return next
  }

  /** Creates the repository with an initial commit of `files`; returns that commit sha. */
  async init(
    tenantId: string,
    projectId: string,
    initial: { files: Record<string, string>; author: GitAuthor; message?: string },
  ): Promise<string> {
    const dir = this.repoPath(tenantId, projectId)
    return this.withLock(dir, async () => {
      await mkdir(dir, { recursive: true })
      const git = this.git(dir)
      await git.init(['--initial-branch=main'])
      await git.addConfig('commit.gpgsign', 'false')
      await git.addConfig('user.name', SYSTEM_COMMITTER.name)
      await git.addConfig('user.email', SYSTEM_COMMITTER.email)
      const paths = Object.keys(initial.files).map(safePath)
      if (paths.length === 0) throw new Error('initial commit needs at least one file')
      for (const [path, content] of Object.entries(initial.files)) {
        await this.put(dir, safePath(path), content)
      }
      return this.commit(git, paths, initial.author, initial.message ?? 'project: init')
    })
  }

  /** Writes one file and commits it; returns the commit sha (unchanged content → current HEAD). */
  async writeFile(tenantId: string, projectId: string, input: WriteInput): Promise<string> {
    const dir = this.repoPath(tenantId, projectId)
    const path = safePath(input.path)
    return this.withLock(dir, async () => {
      const git = this.git(dir)
      await this.put(dir, path, input.content)
      const status = await git.status([path])
      if (status.files.length === 0) return (await git.revparse(['HEAD'])).trim()
      return this.commit(git, [path], input.author, input.message)
    })
  }

  /** File content at `commit` (default HEAD), or null when it does not exist there. */
  async readFile(
    tenantId: string,
    projectId: string,
    path: string,
    commit = 'HEAD',
  ): Promise<string | null> {
    const dir = this.repoPath(tenantId, projectId)
    const clean = safePath(path)
    if (commit === 'HEAD') {
      try {
        return await readFs(join(dir, clean), 'utf8')
      } catch {
        return null
      }
    }
    if (!/^[0-9a-f]{4,64}$/.test(commit)) throw new Error(`invalid commit: ${commit}`)
    try {
      return await this.git(dir).show([`${commit}:${clean}`])
    } catch {
      return null
    }
  }

  /** Commits that touched `path`, newest first. */
  async history(tenantId: string, projectId: string, path: string): Promise<FileVersion[]> {
    const dir = this.repoPath(tenantId, projectId)
    const log = await this.git(dir).log({ file: safePath(path) })
    return log.all.map((entry) => ({
      commit: entry.hash,
      author: { name: entry.author_name, email: entry.author_email },
      message: entry.message,
      createdAt: new Date(entry.date),
    }))
  }

  private async put(dir: string, path: string, content: string): Promise<void> {
    const target = join(dir, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFs(target, content, 'utf8')
  }

  private async commit(
    git: SimpleGit,
    paths: string[],
    author: GitAuthor,
    message: string,
  ): Promise<string> {
    await git.add(paths)
    const result = await git.commit(message, paths, {
      '--author': `${author.name} <${author.email}>`,
    })
    // `commit` returns an abbreviated sha; resolve the full one.
    return (await git.revparse([result.commit || 'HEAD'])).trim()
  }
}
