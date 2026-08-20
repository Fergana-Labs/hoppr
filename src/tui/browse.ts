import { createInterface } from 'node:readline/promises'
import type { Hoppr } from '../core/hoppr.ts'
import { c, relTime } from '../core/out.ts'
import { listPages } from '../store/wiki.ts'

/**
 * A terminal browser built on readline rather than a TUI framework.
 *
 * The full-screen alternative would pull React and a renderer for a surface
 * whose whole job is "search, read, drill into the source" — three verbs that
 * a prompt does well. This keeps `npx hoppr` light and works over SSH and in
 * dumb terminals, where a full-screen TUI does not.
 */
export async function browse(h: Hoppr): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const stats = await h.stats()

  console.log(
    `${c.bold('hoppr')} ${c.dim(h.layout.root)}\n` +
      c.dim(`${stats.raw} captures · ${stats.wiki} pages · ${stats.skills} skills\n`) +
      c.dim('type a question, or: /recent /wiki /tags /skills /open <id> /source <id> /quit\n'),
  )

  let last: Array<{ id: string; refId: string; title: string }> = []

  try {
    for (;;) {
      const line = (await rl.question(c.cyan('› '))).trim()
      if (!line) continue
      if (line === '/quit' || line === '/q') break

      if (line === '/recent') {
        const res = await h.search('', { scope: 'all', limit: 15 })
        last = res.hits.map((x) => ({ id: x.id, refId: x.refId, title: x.title }))
        res.hits.forEach((x, i) => {
          console.log(`${c.dim(String(i + 1).padStart(2))} ${x.title}  ${c.dim(x.kind)}`)
        })
        continue
      }

      if (line === '/wiki') {
        const pages = await listPages(h.layout)
        for (const p of pages) {
          console.log(`${c.dim(p.type.padEnd(11))} ${c.bold(p.slug)}  ${c.dim(p.summary ?? '')}`)
        }
        if (!pages.length) console.log(c.dim('  (nothing curated yet)'))
        continue
      }

      if (line === '/tags') {
        const { loadTaxonomy } = await import('../organize/taxonomy.ts')
        const tax = await loadTaxonomy(h.layout)
        for (const [tag, e] of Object.entries(tax.tags)
          .filter(([, x]) => !x.merged_into)
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 40)) {
          console.log(
            `${String(e.count).padStart(4)}  ${c.cyan(tag)}  ${c.dim(e.description ?? '')}`,
          )
        }
        continue
      }

      if (line === '/skills') {
        const { listSkills } = await import('../organize/skills.ts')
        for (const s of listSkills(await h.db())) {
          console.log(
            `${c.dim(s.state.padEnd(10))} ${c.bold(s.slug)}  ${c.dim(s.description.slice(0, 70))}`,
          )
        }
        continue
      }

      const openMatch = /^\/(open|source)\s+(\S+)$/.exec(line)
      if (openMatch) {
        const [, verb, ref] = openMatch
        // A bare number refers to the last result list — the whole point of a
        // REPL is not retyping identifiers.
        const target = /^\d+$/.test(ref!) ? last[Number(ref) - 1]?.id : ref
        if (!target) {
          console.log(c.dim('no such result'))
          continue
        }
        if (verb === 'source') {
          const rec = await h.resolveRaw(target.replace(/^raw:/, ''))
          if (!rec) {
            console.log(c.dim('no capture behind that'))
            continue
          }
          const { readText } = await import('../store/raw.ts')
          console.log(c.dim(`${rec.path}  ${relTime(rec.captured)}`))
          console.log((await readText(h.layout, rec).catch(() => '(binary)')).slice(0, 4000))
        } else {
          const db = await h.db()
          const doc = db
            .prepare<{ title: string; body: string; summary: string }>(
              'SELECT title, body, summary FROM docs WHERE id = :i',
            )
            .get({ i: target })
          console.log(
            doc ? `${c.bold(doc.title)}\n${doc.summary}\n\n${doc.body}` : c.dim('not found'),
          )
        }
        continue
      }

      const res = await h.search(line, { scope: 'all', limit: 10 })
      last = res.hits.map((x) => ({ id: x.id, refId: x.refId, title: x.title }))
      if (!res.hits.length) {
        console.log(c.dim('no hits'))
        continue
      }
      res.hits.forEach((x, i) => {
        console.log(
          `${c.dim(String(i + 1).padStart(2))} ${c.bold(x.title)}  ${c.dim(x.kind)}${
            x.tags.length ? c.cyan(`  #${x.tags.join(' #')}`) : ''
          }`,
        )
        if (x.snippet) console.log(`   ${c.dim(x.snippet.slice(0, 160))}`)
      })
      console.log(c.dim('   /open <n> to read · /source <n> for the original'))
    }
  } finally {
    rl.close()
  }
}
