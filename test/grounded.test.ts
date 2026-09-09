import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkMove, projectFacts } from '../src/organize/grounded.ts'

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hoppr-ground-'))
  for (const [p, body] of Object.entries(files)) {
    const full = join(dir, p)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, body)
  }
  return dir
}

const NPM_PROJECT = {
  'package.json': JSON.stringify({ scripts: { check: 'tsc', test: 'vitest run' } }),
  'package-lock.json': '{}',
  'src/index.ts': '',
}

describe('grounding a proposed move in the project', () => {
  /**
   * The blind spot this exists for. Replay is a model judging a model against
   * a text stub, so it cannot see a skill telling an agent to run something
   * this project does not have — Environment Mismatch and Artifact
   * Misplacement together are 37 of 125 confirmed functional failures, and
   * neither is visible in any transcript.
   */
  it('catches a script this project does not define', async () => {
    const dir = await project(NPM_PROJECT)
    try {
      const facts = await projectFacts(dir)
      expect(checkMove('Run `npm run check` first.', facts)).toEqual([])
      const bad = checkMove('Run `npm run deploy` to ship it.', facts)
      expect(bad).toHaveLength(1)
      expect(bad[0]?.kind).toBe('missing-script')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('catches the wrong package manager', async () => {
    const dir = await project(NPM_PROJECT)
    try {
      const bad = checkMove('pnpm install the dependency', await projectFacts(dir))
      expect(bad[0]?.kind).toBe('wrong-package-manager')
      expect(bad[0]?.detail).toContain('npm')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('says nothing about the manager when no lockfile settled it', async () => {
    // Without a lockfile any manager is a defensible choice, and calling one
    // foreign would be inventing a rule the project never stated.
    const dir = await project({ 'package.json': JSON.stringify({ scripts: { test: 'x' } }) })
    try {
      expect(checkMove('pnpm install it', await projectFacts(dir))).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('catches a backticked path that is not here', async () => {
    const dir = await project(NPM_PROJECT)
    try {
      const facts = await projectFacts(dir)
      expect(checkMove('Edit `src/index.ts` to add the case.', facts)).toEqual([])
      expect(checkMove('Edit `src/nowhere.ts` to add the case.', facts)[0]?.kind).toBe(
        'missing-path',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  /**
   * A false positive discards a real skill, and the alternative to a mined
   * skill is no skill — so the check fires only where the project has said
   * something definite.
   */
  it('does not fire on prose that merely mentions directories', async () => {
    const dir = await project(NPM_PROJECT)
    try {
      const facts = await projectFacts(dir)
      expect(checkMove('Put it in the source directory next to the others.', facts)).toEqual([])
      // A bare `foo/bar` with no extension reads as a placeholder, not a claim.
      expect(checkMove('Something under `lib/helpers` probably.', facts)).toEqual([])
      // Absolute paths and URLs are not this project's tree.
      expect(checkMove('See `/etc/hosts` and `https://x.dev/a.ts`.', facts)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports nothing at all for a manifest it cannot parse', async () => {
    // A broken manifest tells us nothing; reporting it as a project with no
    // scripts would fail every command a skill names.
    const dir = await project({ 'package.json': '{ not json' })
    try {
      const facts = await projectFacts(dir)
      expect(facts.scripts.size).toBe(0)
      expect(checkMove('Run `npm run check`.', facts)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
