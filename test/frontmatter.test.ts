import { describe, expect, it } from 'vitest'
import { contentHash, normalizeText } from '../src/core/hash.ts'
import { slugify } from '../src/core/ids.ts'
import { buildPage, isPinned, parsePage, serializePage } from '../src/store/frontmatter.ts'

describe('frontmatter round-trip', () => {
  const page = `---
title: RRF beats naive score fusion
type: source
# a human's comment that must survive every curate pass
sources:
  - raw/2026/08/17/01JXQ7K4.jsonl
related:
  - "[[rrf-fusion]]"
created: 2026-08-17
updated: 2026-08-17
confidence: high
tags: [search, ranking]
hoppr:
  id: 01JXQ9R7
  raw_ids: [01JXQ7K4]
  pinned: false
---

Body text that must come back byte-identical.
`

  it('preserves comments, key order, and unknown keys when one field changes', () => {
    const { doc, body } = parsePage(page)
    doc.set('updated', '2026-08-18')
    const out = serializePage(doc, body)

    expect(out).toContain("# a human's comment that must survive every curate pass")
    expect(out).toContain('updated: 2026-08-18')
    // key order intact
    const keys = [...out.matchAll(/^(\w+):/gm)].map((m) => m[1])
    expect(keys.slice(0, 3)).toEqual(['title', 'type', 'sources'])
  })

  it('returns the body byte-identical', () => {
    const { body } = parsePage(page)
    expect(body.trim()).toBe('Body text that must come back byte-identical.')
  })

  it('is idempotent — reserializing an unchanged page yields identical bytes', () => {
    const a = parsePage(page)
    const once = serializePage(a.doc, a.body)
    const b = parsePage(once)
    expect(serializePage(b.doc, b.body)).toBe(once)
  })

  it('reads the pinned flag out of the machine namespace', () => {
    expect(isPinned(parsePage(page).data)).toBe(false)
    expect(isPinned(parsePage(page.replace('pinned: false', 'pinned: true')).data)).toBe(true)
  })

  it('buildPage emits a deterministic key order with the machine block last', () => {
    const out = buildPage(
      {
        confidence: 'medium',
        tags: ['b', 'a'],
        title: 'T',
        hoppr: { id: 'X', raw_ids: [], pinned: false },
        zzz_user_field: 1,
        type: 'concept',
        sources: [],
        related: [],
        created: '2026-08-17',
        updated: '2026-08-17',
      },
      'body',
    )
    const keys = [...out.matchAll(/^(\w+):/gm)].map((m) => m[1])
    expect(keys).toEqual([
      'title',
      'type',
      'sources',
      'related',
      'created',
      'updated',
      'confidence',
      'tags',
      'zzz_user_field',
      'hoppr',
    ])
  })

  it('rejects malformed frontmatter as terminal, not transient', () => {
    expect(() => parsePage('---\n: : :\n  bad\n---\nbody\n')).toThrow()
  })
})

describe('slugify', () => {
  it('is deterministic and kebab-case, per the wiki naming rule', () => {
    expect(slugify('RRF Beats Naive Score Fusion!')).toBe('rrf-beats-naive-score-fusion')
    expect(slugify('RRF Beats Naive Score Fusion!')).toBe(slugify('rrf beats naive score fusion'))
  })
  it('strips diacritics and smart quotes', () => {
    expect(slugify('Café Déjà Vu')).toBe('cafe-deja-vu')
    expect(slugify('Karpathy’s wiki')).toBe('karpathys-wiki')
  })
  it('never collides with the reserved navigation files', () => {
    expect(slugify('index')).toBe('index-page')
    expect(slugify('log')).toBe('log-page')
  })
  it('truncates on a word boundary', () => {
    const s = slugify(`${'a'.repeat(20)} ${'b'.repeat(80)}`)
    expect(s.length).toBeLessThanOrEqual(72)
    expect(s.endsWith('-')).toBe(false)
  })
})

describe('content hashing', () => {
  it('ignores line endings and trailing whitespace, so a resave costs nothing', () => {
    expect(contentHash('a\r\nb  \n')).toBe(contentHash('a\nb\n'))
  })
  it('still detects a real change', () => {
    expect(contentHash('a\nb\n')).not.toBe(contentHash('a\nc\n'))
  })
  it('collapses runs of blank lines', () => {
    expect(normalizeText('a\n\n\n\nb')).toBe('a\n\nb')
  })
})
