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
    if (r !== 'unchanged') written.push(slug)
  }
  return written
}
