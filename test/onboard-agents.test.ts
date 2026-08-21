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

  it('finds agent files in parent directories, nearest first', () => {
    const root = mkdtempSync(join(tmpdir(), 'hoppr-tree-'))
    const { mkdirSync } = require('node:fs') as typeof import('node:fs')
    const deep = join(root, 'a', 'b')
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(root, 'AGENTS.md'), 'root\n')
    writeFileSync(join(deep, 'CLAUDE.md'), 'near\n')

    const found = agentFilesNear(deep)
    expect(found[0]).toBe(join(deep, 'CLAUDE.md'))
    expect(found).toContain(join(root, 'AGENTS.md'))
  })
})
