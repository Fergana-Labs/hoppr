import { describe, expect, it } from 'vitest'
import { isIgnored, parseIgnore, parseIgnoreSets } from '../src/connectors/ignore.ts'

const check = (patterns: string, path: string) => isIgnored(path, parseIgnore(patterns))

describe('ignore patterns', () => {
  it('matches a bare name at any depth', () => {
    expect(check('secrets.md', 'secrets.md')).toBe(true)
    expect(check('secrets.md', 'a/b/secrets.md')).toBe(true)
  })

  it('anchors a pattern that contains a slash', () => {
    // The asymmetry people rely on without knowing it.
    expect(check('/build', 'build/out.md')).toBe(true)
    expect(check('/build', 'src/build/out.md')).toBe(false)
    expect(check('docs/private', 'docs/private/x.md')).toBe(true)
    expect(check('docs/private', 'a/docs/private/x.md')).toBe(false)
  })

  it('stops * at a slash but lets ** cross it', () => {
    expect(check('*.log', 'a/b.log')).toBe(true)
    expect(check('/a/*.md', 'a/b/c.md')).toBe(false)
    expect(check('/a/**/*.md', 'a/b/c.md')).toBe(true)
  })

  it('ignores everything under a matched directory', () => {
    expect(check('node_modules/', 'node_modules/pkg/readme.md')).toBe(true)
  })

  it('lets a later negation re-include', () => {
    // .hopprignore is read after .gitignore precisely so this works.
    expect(check('*.pdf\n!keep.pdf', 'papers/keep.pdf')).toBe(false)
    expect(check('*.pdf\n!keep.pdf', 'papers/other.pdf')).toBe(true)
  })

  it('applies rules in order, so a re-include can be re-excluded', () => {
    expect(check('*.md\n!notes/*.md\nnotes/private.md', 'notes/private.md')).toBe(true)
    expect(check('*.md\n!notes/*.md\nnotes/private.md', 'notes/ok.md')).toBe(false)
  })

  it('skips comments and blank lines', () => {
    expect(parseIgnore('# comment\n\n  \nreal.md')).toHaveLength(1)
  })

  it('treats a character class as one', () => {
    expect(check('draft[0-9].md', 'draft3.md')).toBe(true)
    expect(check('draft[0-9].md', 'draftx.md')).toBe(false)
  })

  it('does not treat a dot as a wildcard', () => {
    expect(check('a.md', 'axmd')).toBe(false)
  })
})

describe('two sections, one file', () => {
  const text = [
    '# not indexed at all',
    'node_modules/',
    '*.zip',
    '',
    '[no-curate]',
    'archive/**',
    '*.csv',
  ].join('\n')

  it('splits skip from no-curate', () => {
    const sets = parseIgnoreSets(text)
    expect(isIgnored('node_modules/x/a.md', sets.skip)).toBe(true)
    expect(isIgnored('archive/old.md', sets.skip)).toBe(false)
    expect(isIgnored('archive/old.md', sets.noCurate)).toBe(true)
    expect(isIgnored('node_modules/x/a.md', sets.noCurate)).toBe(false)
  })

  it('treats everything before any header as skip', () => {
    expect(parseIgnoreSets('a.md\nb.md').skip).toHaveLength(2)
    expect(parseIgnoreSets('a.md\nb.md').noCurate).toHaveLength(0)
  })

  it('can switch back with [index]', () => {
    const sets = parseIgnoreSets('[no-curate]\nx.md\n[index]\ny.md')
    expect(isIgnored('x.md', sets.noCurate)).toBe(true)
    expect(isIgnored('y.md', sets.skip)).toBe(true)
  })

  it('does not let a section header leak into a plain pattern list', () => {
    // parseIgnore is still used for single lists; a stray header must not
    // become a pattern that matches a real file called "[no-curate]".
    expect(parseIgnore('[no-curate]\na.md')).toHaveLength(1)
  })
})

describe('trailing **', () => {
  it('matches everything below the directory', () => {
    // `archive/**` silently matched nothing before: a trailing ** was compiled
    // to an optional directory boundary rather than "any path below".
    expect(check('archive/**', 'archive/old.md')).toBe(true)
    expect(check('archive/**', 'archive/deep/nested/old.md')).toBe(true)
    expect(check('archive/**', 'other/old.md')).toBe(false)
  })

  it('still handles ** in the middle', () => {
    expect(check('/a/**/c.md', 'a/b/c.md')).toBe(true)
    expect(check('/a/**/c.md', 'a/c.md')).toBe(true)
  })
})
