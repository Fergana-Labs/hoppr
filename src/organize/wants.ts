import type { Config } from '../config/schema.ts'
import type { Layout } from '../store/layout.ts'
import { loadPrompt } from '../store/prompts.ts'

/**
 * What should exist before mining stumbles onto it.
 *
 * One question, previously answered by three mechanisms: `seed` shipped files,
 * `targets` named subjects, and the ledger kinds were hardcoded where nobody
 * could reach them. Now two lists of names in `[skills]`:
 *
 *   have — hoppr maintains this one
 *   find — go looking for this procedure in the transcripts
 *
 * A name in `have` is either a list hoppr builds from your sessions or a
 * ready-made file it ships, and the deciding factor is whether the
 * `lesson-extract` prompt defines a bin for it. That is where the questions
 * live — ejected into the store alongside every other prompt, because a
 * paragraph of instructions is prompt-shaped, not config-shaped, and stuffing
 * one into TOML made the config unreadable to say nothing of the repeated
 * `[[skills.want]]` headers it took to get there.
 */
export interface Want {
  name: string
  /** The SKILL.md description — an agent's trigger for reading the file. */
  description: string
  /**
   * The question the extractor is asked for this bin, empty for a shipped file.
   *
   * One generic "what did this session establish?" produced generic answers.
   * Each bin hunts a different *moment* in a transcript — a word being defined,
   * a draft being rejected — and naming that moment is the difference between
   * an extractor that finds things and one that summarizes.
   */
  ask: string
  /** The `## heading` its entries sit under. */
  heading: string
  /**
   * Does each line carry a binding strength?
   *
   * Only meaningful where a bin mixes things that MUST hold with things that
   * are merely how someone likes it. Lumping "never commit to main" together
   * with "prefer shorter sentences" makes an agent treat both as advisory, or
   * both as law, and either one is wrong half the time.
   */
  graded: boolean
}

/** `procedure` is never a ledger — it goes through the miner and the gate. */
export const PROCEDURE = 'procedure'

/**
 * Read the `## Bins` section of the lesson-extract prompt.
 *
 * `### name`, then optional `key: value` lines, then the question. Deliberately
 * not YAML or TOML embedded in Markdown: this is a file people edit to change
 * what hoppr collects, and the moment it needs correct indentation to parse,
 * editing it stops being safe.
 */
export function parseBins(template: string): Map<string, Omit<Want, 'name'>> {
  const out = new Map<string, Omit<Want, 'name'>>()
  const section = /\n##\s+Bins\s*\n([\s\S]*?)(?=\n##\s+(?!#)|\s*$)/.exec(template)
  if (!section?.[1]) return out
  // Split on a line start, not on a preceding newline: the `\s*\n` that ends
  // the `## Bins` header already eats the blank line before the first `###`,
  // so a `\n###` split silently dropped whichever bin came first.
  for (const block of section[1].split(/^###[ \t]+/m).slice(1)) {
    const [head, ...rest] = block.split('\n')
    const name = (head ?? '').trim().toLowerCase()
    if (!name) continue
    let heading = ''
    let description = ''
    let graded = false
    const body: string[] = []
    let inMeta = true
    for (const line of rest) {
      const meta = inMeta ? /^(heading|graded|description):\s*(.*)$/i.exec(line.trim()) : null
      if (meta) {
        const key = meta[1]!.toLowerCase()
        if (key === 'heading') heading = meta[2]!.trim()
        else if (key === 'description') description = meta[2]!.trim()
        else graded = /^(true|yes)$/i.test(meta[2]!.trim())
        continue
      }
      if (line.trim()) inMeta = false
      body.push(line)
    }
    const ask = body.join('\n').trim()
    out.set(name, {
      ask,
      heading: heading || titleCase(name),
      graded,
      // Written, not derived from the question. Deriving it looked like it
      // avoided drift and instead shipped the extractor's own instructions as
      // the file's description — "Which nouns in these sessions would a new
      // agent get wrong?", imperative, addressed to the wrong reader, on a
      // file an agent matches against to decide whether to open it.
      description:
        description ||
        `Standing ${name} recorded from past sessions, one line per subject, each citing the capture it came from.`,
    })
  }
  return out
}

export interface Wants {
  /** Bins built up from your sessions. */
  ledgers: Want[]
  /** Ready-made files hoppr ships. */
  packaged: string[]
  /** Procedures to go looking for. */
  find: string[]
}

export async function resolveWants(l: Layout, cfg: Config): Promise<Wants> {
  const bins = parseBins((await loadPrompt(l, 'lesson-extract')).template)
  const ledgers: Want[] = []
  const packaged: string[] = []
  for (const name of cfg.skills.have) {
    const key = name.toLowerCase()
    // `procedure` is a bin the prompt defines but never a ledger, so naming it
    // in `have` must not mint a `procedure/SKILL.md`.
    if (key === PROCEDURE) continue
    const bin = bins.get(key)
    if (bin) ledgers.push({ name, ...bin })
    else packaged.push(name)
  }
  return { ledgers, packaged, find: cfg.skills.find }
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/[-_]+/g, ' ')
}
