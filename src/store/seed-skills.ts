import type { Config } from '../config/schema.ts'
import { listAssets, readAsset } from '../core/assets.ts'
import { resolveWants } from '../organize/wants.ts'
import { writeIfChanged } from './atomic.ts'
import type { Layout } from './layout.ts'

/**
 * Skills that ship with hoppr, written into a new store.
 *
 * Mining discovers what you do OFTEN. It cannot discover what you have never
 * written down, and in a store's first week it has nothing to cluster at all.
 * These cover the part that matters immediately and that no amount of
 * transcript analysis would surface: how you want to be communicated with, and
 * what "done" means here.
 *
 * They are seeds, not findings, and they say so in their own text. Edit one and
 * it pins — after which the curator maintains its evidence links and leaves the
 * prose alone.
 */
export async function seedSkills(l: Layout, config: Config): Promise<string[]> {
  if (!config.skills.enabled) return []
  const want = new Set((await resolveWants(l, config)).packaged)
  if (want.size === 0) return []

  const written: string[] = []
  // `listAssets` returns the directory names; each holds one SKILL.md.
  for (const slug of await listAssets('skills').catch(() => [])) {
    if (!want.has(slug)) continue
    const body = await readAsset('skills', `${slug}/SKILL.md`).catch(() => '')
    if (!body) continue
    const r = await writeIfChanged(`${l.skills}/${slug}/SKILL.md`, body)
    // Marked `bootstrap`, the same kind `store/bootstrap.ts` uses, because
    // they are the same category of thing: a hypothesis shipped before there
    // is evidence, not a finding mined from any. Without the marker they were
    // adopted as mined procedures and then audited as ones — reported forever
    // as failing an evidence check they can never satisfy, which is how an
    // audit stops being read.
    await writeIfChanged(
      `${l.skills}/${slug}/.hoppr.json`,
      `${JSON.stringify({ slug, managed_by: 'hoppr', kind: 'bootstrap', state: 'accepted' }, null, 2)}\n`,
    )
    if (r !== 'unchanged') written.push(slug)
  }
  return written
}
