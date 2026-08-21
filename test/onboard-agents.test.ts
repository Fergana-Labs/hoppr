import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentFilesNear, annotateAgentFile, hopprBlock } from '../src/onboard-agents.ts'

const block = hopprBlock('notes', '/x/notes/.hoppr', 'Meeting notes and decisions.')

describe('telling agent files a hoppr exists', () => {
  it('appends without touching what was already there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoppr-md-'))
    const f = join(dir, 'CLAUDE.md')
    writeFileSync(f, '# My project\n\nInstructions that must survive.\n')

    const r = await annotateAgentFile(f, block)
    expect(r.outcome).toBe('added')
    const after = readFileSync(f, 'utf8')
    expect(after).toContain('Instructions that must survive.')
    expect(after).toContain('hoppr -H notes search')
  })

  it('replaces its own block rather than stacking them', async () => {
    // The MCP installer's discipline: a marked block, never a rewrite, and a
    // second run must not leave two copies.
    const dir = mkdtempSync(join(tmpdir(), 'hoppr-md-'))
    const f = join(dir, 'AGENTS.md')
    writeFileSync(f, 'keep me\n')

    await annotateAgentFile(f, block)
    await annotateAgentFile(f, hopprBlock('notes', '/x/notes/.hoppr', 'Updated description.'))
    const after = readFileSync(f, 'utf8')
    expect(after.match(/hoppr:begin/g) ?? []).toHaveLength(1)
    expect(after).toContain('Updated description.')
    expect(after).toContain('keep me')
  })

  it('reports unchanged when nothing moved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoppr-md-'))
    const f = join(dir, 'CLAUDE.md')
    writeFileSync(f, 'x\n')
    await annotateAgentFile(f, block)
    expect((await annotateAgentFile(f, block)).outcome).toBe('unchanged')
  })

  it('creates the file when there is none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoppr-md-'))
    const f = join(dir, 'CLAUDE.md')
    expect((await annotateAgentFile(f, block)).outcome).toBe('added')
    expect(readFileSync(f, 'utf8')).toContain('Searchable context')
  })

  it('looks in THIS folder and never walks up', async () => {
    // It used to walk up three directories, so `hoppr init` in ~/Downloads
    // could offer to edit ~/CLAUDE.md — a person's global agent memory, which
    // is not something a folder-indexing command should reach for.
    const { mkdirSync } = await import('node:fs')
    const root = mkdtempSync(join(tmpdir(), 'hoppr-tree-'))
    const deep = join(root, 'a', 'b')
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(root, 'CLAUDE.md'), 'the parent, which must be left alone\n')

    expect(agentFilesNear(deep)).toEqual([])

    writeFileSync(join(deep, 'AGENTS.md'), 'here\n')
    expect(agentFilesNear(deep)).toEqual([join(deep, 'AGENTS.md')])
  })
})

describe('the machine-wide note', () => {
  it('says something different from the per-folder one', async () => {
    const { globalHopprBlock } = await import('../src/onboard-agents.ts')
    const global = globalHopprBlock()
    // A global note is read in projects with nothing to do with any hoppr, so
    // it has to teach discovery rather than describe one store.
    expect(global).toContain('hoppr hoppers')
    expect(global).not.toContain('hoppr -H notes')
    // The per-folder note names its store; the global one cannot.
    expect(block).toContain('hoppr -H notes search')
  })

  it('only looks at files the person already keeps', async () => {
    const { globalAgentFiles } = await import('../src/onboard-agents.ts')
    const { mkdirSync } = await import('node:fs')
    const home = mkdtempSync(join(tmpdir(), 'hoppr-home-'))
    // Nothing there yet: hoppr must not create a global memory file for you.
    expect(globalAgentFiles(home)).toEqual([])

    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'mine\n')
    expect(globalAgentFiles(home)).toEqual([join(home, '.claude', 'CLAUDE.md')])
  })
})
