import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export type WriteResult = 'written' | 'created' | 'unchanged'

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

/**
 * Atomic, skip-if-identical write. Both halves are load-bearing:
 *
 *  - **skip-if-identical** is what keeps `git status` quiet. A nightly pass
 *    inspects thousands of files and changes a handful; without this every
 *    pass would rewrite the whole store and the git diff — which is the
 *    review UI for an autonomous agent — becomes useless noise. It also
 *    breaks the watcher self-trigger loop at the source: no write, no event.
 *  - **tmp + rename** means a crash mid-write can never leave a half-written
 *    page in the source of truth.
 */
export async function writeIfChanged(path: string, content: string): Promise<WriteResult> {
  const dir = dirname(path)
  await ensureDir(dir)

  if (existsSync(path)) {
    const current = await readFile(path, 'utf8')
    if (current === content) return 'unchanged'
  } else {
    await writeAtomic(path, content)
    return 'created'
  }
  await writeAtomic(path, content)
  return 'written'
}

export async function writeAtomic(path: string, content: string | Uint8Array): Promise<void> {
  const dir = dirname(path)
  await ensureDir(dir)
  const tmp = join(dir, `.${basename(path)}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    await writeFile(tmp, content)
    await rename(tmp, path)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
}

/** Append a line to a log file, creating it if needed. Used for wiki/log.md. */
export async function appendLine(path: string, line: string): Promise<void> {
  await ensureDir(dirname(path))
  const { appendFile } = await import('node:fs/promises')
  await appendFile(path, line.endsWith('\n') ? line : `${line}\n`, 'utf8')
}
