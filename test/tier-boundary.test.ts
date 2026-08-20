import { readdir, readFile, stat } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { add } from '../src/intake/add.ts'
import * as rawStore from '../src/store/raw.ts'
import { tempStore } from './helpers.ts'

/**
 * The invariant everything else rests on: the curator cannot damage tier 1.
 * We enforce it structurally rather than by convention, and test the structure
 * — because a rule an LLM is merely *told* to follow is not a rule.
 */
describe('tier boundary', () => {
  it('raw.ts exports no function that rewrites or deletes an existing capture', async () => {
    const src = await readFile(new URL('../src/store/raw.ts', import.meta.url), 'utf8')
    const exported = [...src.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1])

    // The only writers allowed are strictly additive.
    const ALLOWED_WRITERS = new Set(['append', 'extendPartial', 'seal'])
    const FORBIDDEN =
      /^(update|overwrite|replace|delete|remove|rm|unlink|truncate|write|set|edit|patch)/i

    for (const name of exported) {
      if (ALLOWED_WRITERS.has(name!)) continue
      expect(
        FORBIDDEN.test(name!),
        `raw.ts must not export a mutating function, found: ${name}`,
      ).toBe(false)
    }
    expect(exported).toContain('append')
    expect(exported).toContain('readMeta')
  })

  it('no module under src/organize imports a writer from the raw store', async () => {
    const dir = new URL('../src/organize/', import.meta.url)
    let files: string[] = []
    try {
      files = await readdir(dir)
    } catch {
      return // organize/ lands in M3; the guard is here waiting for it
    }
    for (const f of files.filter((f) => f.endsWith('.ts'))) {
      const src = await readFile(new URL(f, dir), 'utf8')
      const named = src.match(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*store\/raw\.ts['"]/)
      if (!named) continue
      for (const sym of named[1]!.split(',').map((s) => s.trim().split(/\s+as\s+/)[0]!)) {
        expect(
          ['append', 'extendPartial', 'seal'].includes(sym),
          `${f} imports the tier-1 writer '${sym}'`,
        ).toBe(false)
      }
    }
  })

  it('captured bytes are never altered after the fact', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const rec = await add(layout, { text: 'the original bytes' })
      const abs = layout.abs(rec.path)
      const before = await readFile(abs)
      const beforeStat = await stat(abs)

      // Adding more captures must not disturb existing ones.
      await add(layout, { text: 'a second capture' })
      await add(layout, { text: 'a third capture' })

      expect(await readFile(abs)).toEqual(before)
      expect((await stat(abs)).mtimeMs).toBe(beforeStat.mtimeMs)
    } finally {
      await cleanup()
    }
  })

  it('refuses to extend a sealed capture', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const rec = await add(layout, { text: 'sealed on arrival' })
      expect(rec.partial).toBe(false)
      await expect(rawStore.extendPartial(layout, rec, 'more')).rejects.toThrow(/sealed/)
    } finally {
      await cleanup()
    }
  })

  it('extending a live capture only appends — earlier bytes stay byte-identical', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const rec = await rawStore.append(layout, {
        bytes: 'line one\n',
        kind: 'session',
        source: 'connector:test',
        mediaType: 'application/x-ndjson',
        partial: true,
      })
      const abs = layout.abs(rec.path)
      const head = await readFile(abs)

      const grown = await rawStore.extendPartial(layout, rec, 'line two\n')
      const full = await readFile(abs)

      expect(full.subarray(0, head.length)).toEqual(head)
      expect(full.toString()).toBe('line one\nline two\n')
      expect(grown.bytes).toBe(full.byteLength)

      const sealed = await rawStore.seal(layout, grown)
      expect(sealed.partial).toBe(false)
      // Sealing touches the sidecar only, never the content.
      expect(await readFile(abs)).toEqual(full)
    } finally {
      await cleanup()
    }
  })
})
