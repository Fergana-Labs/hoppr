import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { Config } from '../config/schema.ts'
import { HopprError } from '../core/errors.ts'
import { slugify } from '../core/ids.ts'
import { docId, upsertDoc } from '../db/docs.ts'
import type { Db } from '../db/driver.ts'
import { type LlmProvider, recordCall } from '../llm/index.ts'
import { writeIfChanged } from '../store/atomic.ts'
import { buildPage } from '../store/frontmatter.ts'
import type { Layout } from '../store/layout.ts'
import { clip, loadPrompt, render } from '../store/prompts.ts'
import { promotionGate, writeResolver } from './skillify.ts'

const SkillOut = z.object({
  slug: z.string().min(2),
  name: z.string().min(2),
  description: z.string().min(10),
  body: z.string().min(20),
  evidence: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
})
const MineOut = z.object({ skills: z.array(SkillOut) })

/** `weak` = mined but failed the promotion gate; kept for audit, never proposed. */
export type SkillState = 'proposed' | 'accepted' | 'installed' | 'rejected' | 'weak'

export interface SkillRow {
  slug: string
  name: string
  description: string
  path: string | null
  state: SkillState
  evidence_count: number
  confidence: number
  pinned: number
}

export interface MineStats {
  candidates: number
  proposed: number
  updated: number
  rejectedAgain: number
  /** Mined but gated out — did not earn a place in every future session. */
  weak: number
  logLine: string
}

/**
 * Mine reusable skills out of past agent sessions.
 *
 * This is the feature that closes the loop: session history stops being
 * exhaust and becomes capability. Three constraints keep it honest.
 *
 *  - **Procedural clustering, not topical.** Two sessions about the same
 *    library are not a skill; two that both fixed a flaky test the same way
 *    are. We cluster on shared tool/error vocabulary rather than subject.
 *  - **The failures are the payload.** A transcript where someone tried A,
 *    hit B, and landed on C encodes the wrong turn — which is the only part
 *    the existing README does not already have.
 *  - **Proposed, never auto-installed.** A skill changes how every future
 *    agent session behaves. That earns thirty seconds of human attention, and
 *    it is the one place in hoppr that is deliberately not automatic.
 */
export async function mineSkills(
  db: Db,
  l: Layout,
  cfg: Config,
  llm: LlmProvider,
  opts: { limit?: number; onProgress?: (m: string) => void } = {},
): Promise<MineStats> {
  const st: MineStats = {
    candidates: 0,
    proposed: 0,
    updated: 0,
    rejectedAgain: 0,
    weak: 0,
    logLine: '',
  }
  if (!cfg.skills.enabled) {
    st.logLine = 'skill mining disabled'
    return st
  }

  const sessions = db
    .prepare<{ id: string; title: string; text: string }>(
      `SELECT id, COALESCE(title,'') AS title, text FROM raw
        WHERE kind = 'session' AND partial = 0 AND text IS NOT NULL
        ORDER BY captured DESC LIMIT :n`,
    )
    .all({ n: opts.limit ?? 60 })

  st.candidates = sessions.length
  if (sessions.length < cfg.skills.min_evidence) {
    st.logLine = `skill mining — only ${sessions.length} sessions, need ${cfg.skills.min_evidence}`
    return st
  }

  const clusters = clusterByProcedure(sessions, cfg.skills.min_evidence)
  if (clusters.length === 0) {
    st.logLine = 'skill mining — no recurring procedure found'
    return st
  }

  const prompt = await loadPrompt(l, 'skill-mine')
  const rejected = new Set(
    db
      .prepare<{ slug: string }>("SELECT slug FROM skills WHERE state = 'rejected'")
      .all()
      .map((r) => r.slug),
  )

  for (const cluster of clusters.slice(0, 5)) {
    opts.onProgress?.(`mining ${cluster.length} related sessions`)
    let out: z.infer<typeof MineOut>
    try {
      const res = await llm.completeJson({
        prompt: render(prompt.template, {
          sessions: cluster
            .map((s) => `### session ${s.id}\n${s.title}\n\n${clip(s.text, 8000)}`)
            .join('\n\n---\n\n'),
        }),
        tier: prompt.tier,
        purpose: 'skills.mine',
        schema: MineOut,
        maxTokens: 8192,
      })
      recordCall(db, llm.id, 'skills.mine', prompt.tier, res.usage, true)
      out = res.value
    } catch (e) {
      opts.onProgress?.(`mining failed: ${(e as Error).message.slice(0, 80)}`)
      continue
    }

    for (const s of out.skills) {
      const slug = slugify(s.slug)
      if (rejected.has(slug)) {
        // A rejection is remembered: re-proposing what a human already
        // declined would make the review queue useless.
        st.rejectedAgain++
        continue
      }

      // Never trust the model's echo of an id. Transcripts contain their own
      // session UUIDs, and models reliably return those instead of the ids we
      // handed them — which silently breaks the provenance chain that makes a
      // mined skill auditable. We KNOW which captures went into this call, so
      // resolve against the cluster and fall back to the whole cluster.
      const known = new Set(cluster.map((c) => c.id))
      const valid = s.evidence.filter((e) => known.has(e))
      // NONE valid means the model echoed ids it read inside the transcripts;
      // fall back to the cluster, whose membership we know. SOME valid but too
      // few is a real signal that the skill is thin — respect it and drop.
      const sources = valid.length === 0 ? cluster.map((c) => c.id) : valid

      // The promotion gate. An installed skill is loaded into EVERY future
      // session, so the bar is "does this earn that", not "is this true".
      const gate = promotionGate({
        slug,
        description: s.description,
        body: s.body,
        evidenceCount: sources.length,
        confidence: s.confidence,
        minEvidence: cfg.skills.min_evidence,
        minConfidence: cfg.skills.min_confidence,
      })
      if (!gate.pass) {
        st.weak++
        opts.onProgress?.(`gated out ${slug}: ${gate.failures[0]}`)
        db.prepare(
          `INSERT INTO skills(slug,name,description,path,state,evidence_count,confidence,created,updated,prompt_hash,pinned)
           VALUES (:slug,:name,:desc,NULL,'weak',:n,:conf,:now,:now,:ph,0)
           ON CONFLICT(slug) DO UPDATE SET
             description=:desc, evidence_count=:n, confidence=:conf, updated=:now,
             state = CASE WHEN skills.state IN ('proposed','weak') THEN 'weak' ELSE skills.state END`,
        ).run({
          slug,
          name: s.name,
          desc: s.description,
          n: sources.length,
          conf: s.confidence,
          now: Date.now(),
          ph: prompt.hash,
        })
        continue
      }

      const existing = db.prepare<SkillRow>('SELECT * FROM skills WHERE slug = :s').get({ s: slug })
      if (existing?.pinned) {
        // Hand-edited: keep accruing evidence, leave the prose alone.
        for (const raw of cluster.map((c) => c.id)) addEvidence(db, slug, raw)
        st.updated++
        continue
      }

      await writeSkillFiles(l, slug, s, sources)
      db.prepare(
        `INSERT INTO skills(slug,name,description,path,state,evidence_count,confidence,created,updated,prompt_hash,pinned)
         VALUES (:slug,:name,:desc,:path,'proposed',:n,:conf,:now,:now,:ph,0)
         ON CONFLICT(slug) DO UPDATE SET
           name=:name, description=:desc, path=:path, evidence_count=:n,
           confidence=:conf, updated=:now, prompt_hash=:ph,
           state = CASE WHEN skills.state = 'rejected' THEN 'rejected' ELSE skills.state END`,
      ).run({
        slug,
        name: s.name,
        desc: s.description,
        path: l.rel(l.skillFile(slug)),
        n: sources.length,
        conf: s.confidence,
        now: Date.now(),
        ph: prompt.hash,
      })
      for (const raw of sources) addEvidence(db, slug, raw)

      upsertDoc(
        db,
        {
          id: docId.skill(slug),
          tier: 'curated',
          kind: 'skill',
          refId: slug,
          title: s.name,
          summary: s.description,
          body: s.body,
          created: Date.now(),
          updated: Date.now(),
        },
        { maxChars: cfg.index.chunk_chars, overlap: cfg.index.chunk_overlap },
      )

      if (existing) st.updated++
      else st.proposed++
    }
  }

  // Keep the dispatcher current so an agent never has to load every skill.
  await writeResolver(l, listSkills(db))

  const bits: string[] = []
  if (st.proposed) bits.push(`${st.proposed} proposed`)
  if (st.updated) bits.push(`${st.updated} updated`)
  if (st.weak) bits.push(`${st.weak} gated out`)
  st.logLine = bits.length
    ? `skill mining — ${bits.join(', ')}${st.proposed ? ' (review with `hoppr skills review`)' : ''}`
    : 'skill mining — nothing new'
  return st
}

function addEvidence(db: Db, slug: string, rawId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO skill_sources(slug, raw_id, role) VALUES (:s,:r,'exemplar')",
  ).run({ s: slug, r: rawId })
}

async function writeSkillFiles(
  l: Layout,
  slug: string,
  s: z.infer<typeof SkillOut>,
  sources: string[],
) {
  // The frontmatter contract is Claude Code's SKILL.md: name + description.
  // Several other harnesses read the same shape, so one mined skill serves
  // more than one agent.
  await writeIfChanged(
    l.skillFile(slug),
    buildPage({ name: slug, description: s.description }, s.body),
  )
  await writeIfChanged(
    l.skillMeta(slug),
    `${JSON.stringify(
      {
        slug,
        managed_by: 'hoppr',
        state: 'proposed',
        evidence_count: sources.length,
        confidence: s.confidence,
        sources: sources.map((raw_id) => ({ raw_id, role: 'exemplar' })),
      },
      null,
      2,
    )}\n`,
  )
}

interface SessionLike {
  id: string
  title: string
  text: string
}

/**
 * Cluster by shared PROCEDURE vocabulary — tool names, commands, error
 * shapes — deliberately ignoring topic words. Two sessions about "auth" are
 * not a skill; two that both ran `vitest --sequence.shuffle` and hit a timer
 * leak are.
 */
export function clusterByProcedure(sessions: SessionLike[], minSize: number): SessionLike[][] {
  const sigs = sessions.map((s) => ({ s, sig: procedureSignature(s.text) }))
  const used = new Set<string>()
  const clusters: SessionLike[][] = []

  for (const a of sigs) {
    if (used.has(a.s.id) || a.sig.size < 3) continue
    const group = [a.s]
    for (const b of sigs) {
      if (b.s.id === a.s.id || used.has(b.s.id)) continue
      if (jaccard(a.sig, b.sig) >= 0.25) group.push(b.s)
    }
    if (group.length >= minSize) {
      for (const g of group) used.add(g.id)
      clusters.push(group)
    }
  }
  return clusters.sort((x, y) => y.length - x.length)
}

const TOOL_LINE = /^→\s+([A-Za-z_][\w-]*)/gm
const COMMAND =
  /\b(npm|pnpm|yarn|git|docker|kubectl|vitest|jest|pytest|cargo|go|make|psql|sqlite3)\s+([a-z:-]+)/g
const ERROR_SHAPE = /\b([A-Z][A-Za-z]*(?:Error|Exception))\b/g

export function procedureSignature(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(TOOL_LINE)) out.add(`tool:${m[1]!.toLowerCase()}`)
  for (const m of text.matchAll(COMMAND)) out.add(`cmd:${m[1]}-${m[2]}`)
  for (const m of text.matchAll(ERROR_SHAPE)) out.add(`err:${m[1]}`)
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const x of a) if (b.has(x)) shared++
  return shared / (a.size + b.size - shared)
}

// ── review + install ────────────────────────────────────────────

export function listSkills(db: Db, state?: SkillState): SkillRow[] {
  return db
    .prepare<SkillRow>(
      state
        ? 'SELECT * FROM skills WHERE state = :s ORDER BY confidence DESC'
        : 'SELECT * FROM skills ORDER BY confidence DESC',
    )
    .all(state ? { s: state } : undefined)
}

export function setSkillState(db: Db, slug: string, state: SkillState): void {
  const r = db
    .prepare('UPDATE skills SET state = :st, updated = :now WHERE slug = :s')
    .run({ s: slug, st: state, now: Date.now() })
  if (r.changes === 0) throw HopprError.notFound(`no skill '${slug}'`)
}

export function skillEvidence(db: Db, slug: string): Array<{ raw_id: string; role: string }> {
  return db
    .prepare<{ raw_id: string; role: string }>(
      'SELECT raw_id, role FROM skill_sources WHERE slug = :s',
    )
    .all({ s: slug })
}

export type InstallOutcome = 'installed' | 'skipped' | 'conflict' | 'failed'

export interface SkillInstallResult {
  slug: string
  target: string
  outcome: InstallOutcome
  detail?: string
}

/**
 * Install into a harness's skills directory.
 *
 * Same ownership discipline as the MCP installer: the `.hoppr.json` marker is
 * what makes a directory ours. A skill directory that exists WITHOUT it is
 * never overwritten — people hand-write skills, and silently replacing one
 * would be unforgivable.
 */
export async function installSkill(
  l: Layout,
  db: Db,
  slug: string,
  o: { target?: string; force?: boolean } = {},
): Promise<SkillInstallResult> {
  const row = db.prepare<SkillRow>('SELECT * FROM skills WHERE slug = :s').get({ s: slug })
  if (!row) throw HopprError.notFound(`no skill '${slug}'`)
  if (row.state === 'proposed' && !o.force) {
    throw HopprError.user(
      `'${slug}' is still a proposal — run \`hoppr skills review\` (or pass --force) first.\n` +
        'A skill changes how every future agent session behaves, so it gets a human gate.',
    )
  }

  const targetRoot = o.target ?? join(homedir(), '.claude', 'skills')
  const dir = join(targetRoot, slug)
  const marker = join(dir, '.hoppr.json')

  if (existsSync(dir) && !existsSync(marker) && !o.force) {
    return {
      slug,
      target: dir,
      outcome: 'conflict',
      detail: 'a skill directory exists here that hoppr did not create — refusing to overwrite',
    }
  }

  try {
    const body = await readFile(l.skillFile(slug), 'utf8')
    const meta = await readFile(l.skillMeta(slug), 'utf8').catch(() => '{}')
    const a = await writeIfChanged(join(dir, 'SKILL.md'), body)
    await writeIfChanged(marker, meta)
    // Ship the dispatcher next to the skills so the harness can route without
    // loading every SKILL.md into the turn.
    await writeIfChanged(
      join(targetRoot, 'RESOLVER.md'),
      await readFile(join(l.skills, 'RESOLVER.md'), 'utf8').catch(() => ''),
    )
    db.prepare(
      'INSERT OR REPLACE INTO skill_installs(slug, target, installed_at) VALUES (:s,:t,:at)',
    ).run({ s: slug, t: dir, at: Date.now() })
    setSkillState(db, slug, 'installed')
    return { slug, target: dir, outcome: a === 'unchanged' ? 'skipped' : 'installed' }
  } catch (e) {
    return { slug, target: dir, outcome: 'failed', detail: (e as Error).message }
  }
}

export async function uninstallSkill(
  db: Db,
  slug: string,
  target?: string,
): Promise<SkillInstallResult> {
  const dir = target ?? join(homedir(), '.claude', 'skills', slug)
  if (!existsSync(join(dir, '.hoppr.json'))) {
    return { slug, target: dir, outcome: 'skipped', detail: 'not hoppr-managed' }
  }
  const { rm } = await import('node:fs/promises')
  await rm(dir, { recursive: true, force: true })
  db.prepare('DELETE FROM skill_installs WHERE slug = :s AND target = :t').run({ s: slug, t: dir })
  setSkillState(db, slug, 'accepted')
  return { slug, target: dir, outcome: 'installed', detail: 'removed' }
}
