import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Config } from '../config/schema.ts'
import { defaults } from '../config/schema.ts'
import { isoDate } from '../core/ids.ts'
import { ensureDir, writeIfChanged } from './atomic.ts'
import { renderClaudeMd } from './claudemd.ts'
import * as gitmod from './git.ts'
import { GITIGNORE, Layout, storeDirs } from './layout.ts'
import { ejectPrompts } from './prompts.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Locate a packaged asset in both source (src/) and built (dist/) layouts. */
async function asset(name: string): Promise<string> {
  for (const p of [
    join(HERE, '..', '..', 'assets', name),
    join(HERE, '..', 'assets', name),
    join(HERE, 'assets', name),
  ]) {
    if (existsSync(p)) return readFile(p, 'utf8')
  }
  throw new Error(`packaged asset missing: ${name}`)
}

export interface InitResult {
  root: string
  created: boolean
  gitInitialized: boolean
}

export async function initStore(root: string, cfg?: Config): Promise<InitResult> {
  const l = new Layout(root)
  const existed = existsSync(l.configFile)
  const config = cfg ?? defaults()

  // A reference-mode hoppr never owns raw bytes, so it gets no raw/ directory
  // to sit there empty and imply otherwise.
  const owned = config.hopper.raw_mode !== 'reference'
  for (const d of storeDirs(l, { raw: owned })) await ensureDir(d)

  // A hoppr created by `hoppr new` already has its own config; only seed the
  // default template for a bare store.
  if (!existsSync(l.configFile)) {
    await writeIfChanged(l.configFile, await asset('hoppr.default.toml'))
  }
  await writeIfChanged(l.gitignore, GITIGNORE)
  if (config.wiki.claude_md) {
    await writeIfChanged(l.claudeMd, renderClaudeMd(config))
  }

  await seedWiki(l)
  await seedTags(l)
  // Prompts are ejected so they are yours to edit; editing one re-stales
  // exactly what it produced, and the next pass regenerates it.
  await ejectPrompts(l)

  const hadGit = gitmod.isRepo(root)
  if (config.git.mode !== 'off') {
    await gitmod.init(root)
    // Commit the skeleton immediately. Without this the FIRST curate pass
    // sweeps every pre-existing file into its commit, and the property that
    // makes git the review layer — "a curate commit touches only curated/" —
    // is false exactly when someone first looks at it.
    if (!hadGit) await gitmod.commit(root, 'hoppr init').catch(() => null)
  }

  return { root, created: !existed, gitInitialized: !hadGit && gitmod.isRepo(root) }
}

/**
 * index.md and log.md are the LLM-wiki spec's two navigation files. index.md is
 * regenerated deterministically after every pass — a catalog is exactly the
 * thing code does better than a model, and never drifts on.
 */
async function seedWiki(l: Layout): Promise<void> {
  await writeIfChanged(
    l.wikiIndex,
    `# Index

_Nothing curated yet._ Throw something in with \`hoppr add\`, then run
\`hoppr curate --fast\` (or start the daemon and it happens on its own).

This file is generated after every curate pass. Do not hand-edit it.
`,
  )
  if (!existsSync(l.wikiLog)) {
    await writeIfChanged(
      l.wikiLog,
      `# Log

Append-only record of every curate operation. Newest entries at the bottom.

- ${isoDate(new Date())} — store initialized
`,
    )
  }
  await writeIfChanged(
    l.wikiOverview,
    `# Overview

The narrative front door to this wiki. The curator maintains it once there is
enough here to summarize; until then it is yours to write.
`,
  )
}

async function seedTags(l: Layout): Promise<void> {
  if (existsSync(l.tagsFile)) return
  await writeIfChanged(
    l.tagsFile,
    `# The tag vocabulary. Agent-maintained, human-editable.
#
# Existing tags are fed back to the model as preferred vocabulary on every
# pass, so the set converges instead of drifting into near-duplicates like
# "ai-agents" / "agentic AI" / "LLM agents". Pin a tag to protect it from
# ever being merged away.
version: 1
tags: {}
`,
  )
}
