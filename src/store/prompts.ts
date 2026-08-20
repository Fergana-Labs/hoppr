import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { listAssets, readAsset } from '../core/assets.ts'
import { contentHash } from '../core/hash.ts'
import { writeIfChanged } from './atomic.ts'
import { parsePage } from './frontmatter.ts'
import type { Layout } from './layout.ts'

export interface Prompt {
  id: string
  tier: 'fast' | 'quality'
  maxInputChars: number
  system?: string
  template: string
  /** Changing a prompt changes this, which re-stales everything it produced. */
  hash: string
  source: 'store' | 'packaged'
}

/**
 * Prompts ship as packaged defaults and are EJECTED into the store on init, so
 * you own them. Resolution is store-first, packaged as fallback.
 *
 * The mechanic that makes this more than a convenience: every page and row
 * records the `prompt_hash` it was produced under. Editing a prompt changes
 * the hash, which marks exactly what that prompt touched as stale, and the
 * next pass regenerates it. Edit, save, and the corpus re-curates itself —
 * while `pinned` pages keep whatever you wrote by hand.
 */
export async function loadPrompt(l: Layout, id: string): Promise<Prompt> {
  const storePath = l.promptFile(id)
  const [text, source] = existsSync(storePath)
    ? [await readFile(storePath, 'utf8'), 'store' as const]
    : [await readAsset('prompts', `${id}.md`), 'packaged' as const]

  const { data, body } = parsePage(text)
  const d = data as Record<string, unknown>
  return {
    id,
    tier: (d.tier === 'quality' ? 'quality' : 'fast') as 'fast' | 'quality',
    maxInputChars: Number(d.max_input_chars ?? 6000),
    system: typeof d.system === 'string' ? d.system : undefined,
    template: body.trim(),
    hash: contentHash(body),
    source,
  }
}

export async function ejectPrompts(l: Layout): Promise<string[]> {
  const written: string[] = []
  for (const file of await listAssets('prompts')) {
    if (!file.endsWith('.md')) continue
    const r = await writeIfChanged(
      l.promptFile(file.replace(/\.md$/, '')),
      await readAsset('prompts', file),
    )
    if (r !== 'unchanged') written.push(file)
  }
  return written
}

export async function listPromptIds(_l: Layout): Promise<string[]> {
  const packaged = (await listAssets('prompts')).filter((f) => f.endsWith('.md'))
  return packaged.map((f) => f.replace(/\.md$/, '')).sort()
}

/**
 * Deliberately dumb templating: `{{var}}` substitution from a fixed context,
 * no conditionals, no loops. Prompts are configuration that humans edit and
 * diff, not a second program to debug.
 */
export function render(template: string, ctx: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) =>
    key in ctx ? String(ctx[key]) : `{{${key}}}`,
  )
}

/** Head + tail, so a long transcript keeps both its setup and its conclusion. */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.7)
  const tail = maxChars - head
  return `${text.slice(0, head)}\n\n… [${text.length - maxChars} characters elided] …\n\n${text.slice(-tail)}`
}
