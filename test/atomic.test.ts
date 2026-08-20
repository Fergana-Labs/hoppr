import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeIfChanged } from '../src/store/atomic.ts'
import * as gitmod from '../src/store/git.ts'
import { tempStore } from './helpers.ts'

/**
 * Skip-if-identical is load-bearing twice over: it keeps `git diff` usable as
 * the review UI for an autonomous agent, and it breaks the file-watcher
 * self-trigger loop at the source (no write, no event, no re-curate).
 */
describe('skip-if-identical writes', () => {
  it('reports created / written / unchanged and leaves mtime alone when unchanged', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const p = join(layout.root, 'curated', 'probe.md')

      expect(await writeIfChanged(p, 'alpha\n')).toBe('created')
      const t1 = (await stat(p)).mtimeMs

      await new Promise((r) => setTimeout(r, 12))
      expect(await writeIfChanged(p, 'alpha\n')).toBe('unchanged')
      expect((await stat(p)).mtimeMs).toBe(t1)

      expect(await writeIfChanged(p, 'beta\n')).toBe('written')
      expect(await readFile(p, 'utf8')).toBe('beta\n')
    } finally {
      await cleanup()
    }
  })

  it('a pass that inspects many files and changes few produces a diff of exactly those few', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const dir = join(layout.root, 'curated', 'wiki', 'sources')
      const N = 200
      for (let i = 0; i < N; i++) {
        await writeFile(join(dir, `page-${i}.md`), `# page ${i}\nbody\n`)
      }
      await gitmod.git(layout.root, ['add', '-A'])
      await gitmod.git(layout.root, ['commit', '-q', '-m', 'baseline'])

      // Simulate a curate pass: re-serialize every page, change 3.
      let changed = 0
      for (let i = 0; i < N; i++) {
        const body = i % 67 === 0 ? `# page ${i}\nbody EDITED\n` : `# page ${i}\nbody\n`
        const r = await writeIfChanged(join(dir, `page-${i}.md`), body)
        if (r !== 'unchanged') changed++
      }

      expect(changed).toBe(3)
      const dirty = (await gitmod.git(layout.root, ['status', '--porcelain'])).split('\n')
      expect(dirty).toHaveLength(3)
    } finally {
      await cleanup()
    }
  })

  it('commit is a no-op when nothing changed', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      // `hoppr init` already commits the skeleton, so there is nothing left to
      // commit here — which is exactly the no-op case this asserts.
      expect(await gitmod.commit(layout.root, 'nothing changed')).toBeNull()

      await writeFile(join(layout.root, 'curated', 'new-page.md'), 'body\n')
      const sha = await gitmod.commit(layout.root, 'a real change')
      expect(sha).toMatch(/^[0-9a-f]{40}$/)
      expect(await gitmod.commit(layout.root, 'still nothing')).toBeNull()
    } finally {
      await cleanup()
    }
  })
})
