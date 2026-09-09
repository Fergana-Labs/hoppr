import { describe, expect, it } from 'vitest'
import { defaults } from '../src/config/schema.ts'
import { Hoppr } from '../src/core/hoppr.ts'
import type { JsonOptions, LlmProvider } from '../src/llm/provider.ts'
import {
  clusterKeys,
  correctionTotals,
  correctionWindow,
  extractCorrections,
  failureModes,
  knownModes,
  normalizeMode,
  rankByRegret,
  SEED_MODES,
} from '../src/organize/corrections.ts'
import { mineGuardrails } from '../src/organize/guardrails.ts'
import { buildMirror } from '../src/organize/mirror.ts'
import { Layout } from '../src/store/layout.ts'
import { tempStore } from './helpers.ts'

class MockLlm implements LlmProvider {
  readonly id = 'mock'
  readonly supportsVision = true
  calls = 0
  readonly responses: unknown[]
  constructor(responses: unknown[]) {
    this.responses = responses
  }
  async available() {
    return true
  }
  async completeText() {
    return { text: '', usage: {} }
  }
  async completeJson<T>(o: JsonOptions<T>) {
    const raw = this.responses[Math.min(this.calls, this.responses.length - 1)]
    this.calls++
    return { value: o.schema.parse(raw), usage: { costUsd: 0.001 } }
  }
}

async function store() {
  const t = await tempStore()
  const h = new Hoppr({ layout: new Layout(t.layout.root), config: defaults(), sources: [] })
  return { ...t, h }
}

/** The shape `renderTranscript` writes: user turns are quoted twice, on purpose. */
function transcript(said: string[], agentSaid = 'Done — that should work now.') {
  return [
    '## Session',
    '',
    '- source: claude-code',
    '',
    '## Prompts',
    '',
    ...said.map((p) => `> ${p}`),
    '',
    '## Transcript',
    '',
    ...said.map((p) => `**user:** ${p}`),
    `**assistant:** ${agentSaid}`,
  ].join('\n')
}

async function seedSession(h: Hoppr, id: string, text: string, observed = Date.now()) {
  const db = await h.db()
  db.prepare(
    `INSERT INTO raw(id,path,kind,source,media_type,bytes,content_hash,created,captured,text,partial)
     VALUES (:id,:p,'session','connector:claude-code','text/markdown',:b,:h,:t,:t,:text,0)`,
  ).run({ id, p: `raw/${id}.md`, b: text.length, h: id, t: observed, text })
}

const SAID = 'did you actually run the tests or are you just guessing again'

function correction(over: Record<string, unknown> = {}) {
  return {
    session: 'S0',
    mode: 'claimed-done-without-running',
    headline: 'Reported the fix as working without running anything.',
    quote: SAID,
    turns: 4,
    severity: 'rework',
    confidence: 0.9,
    ...over,
  }
}

describe('correction extraction', () => {
  it('keeps a correction the person actually made', async () => {
    const { layout, h, cleanup } = await store()
    try {
      await seedSession(h, 'S0', transcript([SAID]))
      const st = await extractCorrections(
        await h.db(),
        layout,
        defaults(),
        new MockLlm([{ corrections: [correction()] }]),
      )
      expect(st.corrections).toBe(1)
      expect(correctionTotals(await h.db())).toEqual({ corrections: 1, sessions: 1, turns: 4 })
      h.close()
    } finally {
      await cleanup()
    }
  })

  /**
   * The failure mode this guard exists for: an assistant apologizing for itself
   * is the most quotable prose in any transcript, and without attribution the
   * top of every report becomes whatever the model most likes to apologize for
   * rather than what actually cost anyone anything.
   */
  it('drops a correction quoting the agent rather than the person', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const apology = 'You are right, I should have run the tests before saying it was fixed'
      await seedSession(h, 'S0', transcript([SAID], apology))
      const st = await extractCorrections(
        await h.db(),
        layout,
        defaults(),
        new MockLlm([
          { corrections: [correction({ quote: apology }), correction({ mode: 'kept-one' })] },
        ]),
      )
      expect(st.unattributed).toBe(1)
      expect(st.corrections).toBe(1)
      expect(failureModes(await h.db()).map((m) => m.mode)).toEqual(['kept-one'])
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('is idempotent per session and mode, keeping the larger turn estimate', async () => {
    const { layout, h, cleanup } = await store()
    try {
      await seedSession(h, 'S0', transcript([SAID]))
      const db = await h.db()
      await extractCorrections(
        db,
        layout,
        defaults(),
        new MockLlm([{ corrections: [correction({ turns: 4 }), correction({ turns: 9 })] }]),
      )
      const modes = failureModes(db)
      expect(modes).toHaveLength(1)
      expect(modes[0]?.turns).toBe(9)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('reads each session only once', async () => {
    const { layout, h, cleanup } = await store()
    try {
      await seedSession(h, 'S0', transcript([SAID]))
      const db = await h.db()
      const llm = new MockLlm([{ corrections: [correction()] }])
      await extractCorrections(db, layout, defaults(), llm)
      const second = await extractCorrections(db, layout, defaults(), llm)
      expect(second.sessionsRead).toBe(0)
      expect(llm.calls).toBe(1)
      h.close()
    } finally {
      await cleanup()
    }
  })
})

describe('correctionWindow', () => {
  /**
   * The defect this fixes: on 48 real sessions the clipped version found five
   * corrections, every one a singleton, because a 200KB transcript clipped to
   * its head and tail keeps the setup and the conclusion and discards the
   * middle — which is where the arguing is.
   */
  it('keeps the user turns out of the middle of a long transcript', () => {
    const filler = 'assistant prose that nobody objected to. '.repeat(400)
    const text = [
      '## Transcript',
      '',
      '**user:** start on this please',
      `**assistant:** ${filler}`,
      '**assistant:** I have rewritten the whole file.',
      '**user:** why did you rewrite it, I asked for one line',
      `**assistant:** ${filler}`,
      '**user:** fine, ship it',
    ].join('\n')

    const kept = correctionWindow(text, 4000)
    expect(kept).toContain('why did you rewrite it')
    // …along with what it was reacting to, which is the half that names the mode.
    expect(kept).toContain('I have rewritten the whole file.')
    expect(kept.length).toBeLessThan(text.length / 2)
  })

  /**
   * `renderTranscript` truncates the transcript body through the MIDDLE on a
   * long session and keeps `## Prompts` whole, because that block is the only
   * part a human actually wrote. Reading only the body therefore loses the
   * user turns from the middle of exactly the long, messy sessions where the
   * corrections are.
   */
  it('recovers user turns the truncated body no longer contains', () => {
    const text = [
      '## Session',
      '',
      '## Prompts',
      '',
      '> start on this please',
      '> why did you rewrite it, I asked for one line',
      '> fine, ship it',
      '',
      '## Transcript',
      '',
      '**user:** start on this please',
      '**assistant:** working on it',
      '',
      '… [90000 characters elided] …',
      '',
      '**user:** fine, ship it',
    ].join('\n')

    const kept = correctionWindow(text, 4000)
    expect(kept).toContain('why did you rewrite it, I asked for one line')
    // …and the pairs that DID survive are not repeated underneath it.
    expect(kept.match(/fine, ship it/g)).toHaveLength(1)
  })

  it('falls back to clipping a transcript whose shape it does not recognize', () => {
    // A connector whose rendering this does not know is better read badly than
    // not at all — so the fallback must shorten, not return nothing.
    const text = 'a plain document with no rendered turns at all. '.repeat(50)
    const clipped = correctionWindow(text, 200)
    expect(clipped.length).toBeGreaterThan(0)
    expect(clipped.length).toBeLessThan(text.length / 4)
  })
})

describe('mode vocabulary', () => {
  /**
   * The measurement that motivated this: 48 real sessions produced 25
   * corrections and 25 distinct modes, none recurring — while six of them were
   * plainly the same mistake worded six ways. Token clustering cannot rescue
   * that, because those strings share almost no words, so the vocabulary has
   * to converge at extraction time the way the tag taxonomy does.
   */
  it('offers what this corpus already uses, most-used first', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const db = await h.db()
      await seedSession(h, 'S0', transcript([SAID]), 2000)
      await seedSession(h, 'S1', transcript([SAID]), 1000)
      await extractCorrections(
        db,
        layout,
        defaults(),
        // Both sessions land in one batch at BATCH = 2, so one response.
        new MockLlm([
          {
            corrections: [
              correction({ session: 'S1', mode: 'a-local-habit' }),
              correction({ session: 'S0', mode: 'a-local-habit' }),
            ],
          },
        ]),
      )
      const vocab = knownModes(db)
      expect(vocab[0]).toEqual({ mode: 'a-local-habit', n: 2 })
      // …and the seeds are still offered underneath, so a fresh corpus is not
      // left to coin whatever the first four sessions happened to suggest.
      expect(vocab.map((v) => v.mode)).toContain('claimed-done-without-running')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('offers only the seeds when nothing has been extracted yet', async () => {
    const { h, cleanup } = await store()
    try {
      const vocab = knownModes(await h.db())
      expect(vocab.every((v) => v.n === 0)).toBe(true)
      expect(vocab).toHaveLength(SEED_MODES.length)
      h.close()
    } finally {
      await cleanup()
    }
  })
})

describe('normalizeMode', () => {
  it('collapses the ways a model writes the same mode', () => {
    for (const s of [
      'Claimed done without running',
      'claimed_done_without_running',
      'claimed-done-without-running.',
    ]) {
      expect(normalizeMode(s)).toBe('claimed-done-without-running')
    }
  })
})

describe('failure modes', () => {
  /**
   * The ordering that makes the report worth reading. A count answers "what
   * happens most", which people can usually guess; turns answer "what is this
   * costing me", which they cannot, and the two orderings disagree.
   */
  it('ranks by turns burned, not by how often it happened', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const db = await h.db()
      await seedSession(h, 'S0', transcript([SAID]), 1000)
      await seedSession(h, 'S1', transcript([SAID]), 2000)
      await seedSession(h, 'S2', transcript([SAID]), 3000)
      // Newest first and two sessions per call, so this is two batches:
      // [S2, S1] then [S0]. One response each — a mock that replayed the same
      // answer for both would credit every session with every correction.
      await extractCorrections(
        db,
        layout,
        defaults(),
        new MockLlm([
          {
            corrections: [
              correction({ session: 'S2', mode: 'wrong-direction-pursued', turns: 20 }),
              correction({ session: 'S1', mode: 'small-frequent-slip', turns: 1 }),
            ],
          },
          { corrections: [correction({ session: 'S0', mode: 'small-frequent-slip', turns: 1 })] },
        ]),
      )
      const modes = failureModes(db)
      expect(modes.map((m) => m.mode)).toEqual(['wrong-direction-pursued', 'small-frequent-slip'])
      expect(modes[0]?.rawIds).toHaveLength(1)
      expect(modes[1]?.rawIds).toHaveLength(2)
      h.close()
    } finally {
      await cleanup()
    }
  })

  /**
   * Turns measure how long you argued, not what the mistake cost. The most
   * expensive correction found on real transcripts — an agent indexing
   * 1Password credentials off the filesystem — took one turn to stop, and
   * sorted below a run of cosmetic notes about spacing.
   */
  it('puts one damaging mistake above a pile of cheap ones', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const db = await h.db()
      await seedSession(h, 'S0', transcript([SAID]), 1000)
      await seedSession(h, 'S1', transcript([SAID]), 2000)
      await extractCorrections(
        db,
        layout,
        defaults(),
        new MockLlm([
          {
            corrections: [
              correction({
                session: 'S1',
                mode: 'indexed-a-secret',
                turns: 1,
                severity: 'damage',
              }),
              correction({
                session: 'S0',
                mode: 'nitpicked-spacing',
                turns: 8,
                severity: 'annoyance',
              }),
            ],
          },
        ]),
      )
      const modes = failureModes(db)
      expect(modes.map((m) => m.mode)).toEqual(['indexed-a-secret', 'nitpicked-spacing'])
      // …and turns are still reported honestly, unweighted.
      expect(modes[0]?.turns).toBe(1)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('clusters two spellings of one mistake and keeps the worst severity', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const db = await h.db()
      await seedSession(h, 'S0', transcript([SAID]), 1000)
      await seedSession(h, 'S1', transcript([SAID]), 2000)
      await extractCorrections(
        db,
        layout,
        defaults(),
        new MockLlm([
          {
            corrections: [
              correction({
                session: 'S0',
                mode: 'claimed-done-without-running',
                severity: 'annoyance',
              }),
              correction({
                session: 'S1',
                mode: 'claiming-done-without-running-it',
                severity: 'damage',
              }),
            ],
          },
        ]),
      )
      const modes = failureModes(db)
      expect(modes).toHaveLength(1)
      expect(modes[0]?.severity).toBe('damage')
      expect(modes[0]?.rawIds).toHaveLength(2)
      h.close()
    } finally {
      await cleanup()
    }
  })
})

const GOOD_GUARDRAIL = {
  slug: 'run-before-reporting',
  name: 'Run Before Reporting',
  description:
    'Use when you are about to report that a change works or is finished, before writing the summary.',
  body: [
    '## The rule',
    'Run it before you say it works.',
    '## Procedure',
    '1. `npm run check`',
    '2. `npm test`',
    '3. Quote the counts in the summary.',
    '## What goes wrong',
    `- Claiming a fix works because the types check. The person asked: "${SAID}"`,
    '## Do not use when',
    '- the change is a comment or a rename, where running proves nothing',
  ].join('\n\n'),
  reusable: true,
  confidence: 0.9,
  problem: '',
}

describe('guardrails', () => {
  it('records the mode it was mined from, so the link is causal', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const db = await h.db()
      await seedSession(h, 'S0', transcript([SAID]))
      await extractCorrections(
        db,
        layout,
        defaults(),
        new MockLlm([{ corrections: [correction()] }]),
      )
      const { stats, results } = await mineGuardrails(
        db,
        layout,
        defaults(),
        new MockLlm([GOOD_GUARDRAIL]),
        failureModes(db),
      )
      expect(stats.proposed).toBe(1)
      expect(results[0]?.mode).toBe('claimed-done-without-running')
      const row = db
        .prepare<{ prevents: string; kind: string; state: string }>(
          'SELECT prevents, kind, state FROM skills WHERE slug = :s',
        )
        .get({ s: 'run-before-reporting' })
      expect(row).toEqual({
        prevents: 'claimed-done-without-running',
        kind: 'guardrail',
        state: 'proposed',
      })
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('writes nothing when the miner says the mode is not one repeatable failure', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const db = await h.db()
      await seedSession(h, 'S0', transcript([SAID]))
      await extractCorrections(
        db,
        layout,
        defaults(),
        new MockLlm([{ corrections: [correction()] }]),
      )
      const { stats } = await mineGuardrails(
        db,
        layout,
        defaults(),
        new MockLlm([{ ...GOOD_GUARDRAIL, reusable: false, problem: 'one bad afternoon' }]),
        failureModes(db),
      )
      expect(stats.declined).toBe(1)
      expect(stats.proposed).toBe(0)
      h.close()
    } finally {
      await cleanup()
    }
  })

  /**
   * Measured on real evidence: mined guardrails came back at 330 characters —
   * three clauses and a parenthetical, with the trigger buried in the middle.
   * Both the dispatcher and the front door render a description as one table
   * cell and truncate it, so the tail is invisible exactly where it is meant
   * to be matched against, while still costing every session the tokens.
   */
  it('gates out a description too long to scan in a dispatch table', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const db = await h.db()
      await seedSession(h, 'S0', transcript([SAID]))
      await extractCorrections(
        db,
        layout,
        defaults(),
        new MockLlm([{ corrections: [correction()] }]),
      )
      const { stats } = await mineGuardrails(
        db,
        layout,
        defaults(),
        new MockLlm([
          {
            ...GOOD_GUARDRAIL,
            description: `Use when you are about to ${'do a very particular thing '.repeat(12)}`,
          },
        ]),
        failureModes(db),
      )
      expect(stats.weak).toBe(1)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('gates out a rule with no procedure under it', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const db = await h.db()
      await seedSession(h, 'S0', transcript([SAID]))
      await extractCorrections(
        db,
        layout,
        defaults(),
        new MockLlm([{ corrections: [correction()] }]),
      )
      const { stats } = await mineGuardrails(
        db,
        layout,
        defaults(),
        new MockLlm([
          {
            ...GOOD_GUARDRAIL,
            body:
              '## The rule\n\nAlways be careful and verify your work.\n\n' +
              '## Do not use when\n- never, it always applies',
          },
        ]),
        failureModes(db),
      )
      expect(stats.weak).toBe(1)
      expect(stats.proposed).toBe(0)
      h.close()
    } finally {
      await cleanup()
    }
  })
})

describe('splitting a mode that holds more than one failure', () => {
  /**
   * The cost of the converged vocabulary, measured. On this store
   * `built-before-clarifying` absorbed three unrelated jobs; a guardrail mined
   * from it had to pick one, and the mode then counted three occurrences of a
   * failure the skill prevents once.
   */
  it('separates unrelated jobs filed under one mode', async () => {
    const rows = [
      {
        id: 'a',
        mode: 'built-before-clarifying',
        headline: 'Created four config types when the user specified only two types.',
      },
      {
        id: 'b',
        mode: 'built-before-clarifying',
        headline: 'Created extra config types beyond the two types requested.',
      },
      {
        id: 'c',
        mode: 'built-before-clarifying',
        headline: 'Rebuilt the artwork from its own interpretation without the reference image.',
      },
    ] as never as Parameters<typeof clusterKeys>[0]

    const keys = await clusterKeys(rows)
    // The two about config types are one failure; the artwork one is not.
    expect(keys.get('a')).toBe(keys.get('b'))
    expect(keys.get('c')).not.toBe(keys.get('a'))
    // The largest group keeps the plain mode name, so existing keys survive.
    expect(keys.get('a')).toBe('built-before-clarifying')
    expect(keys.get('c')).toMatch(/~2$/)
  })

  it('leaves a mode that holds together completely alone', async () => {
    const rows = [
      {
        id: 'a',
        mode: 'claimed-done-without-running',
        headline: 'Claimed the tests passed without running the tests.',
      },
      {
        id: 'b',
        mode: 'claimed-done-without-running',
        headline: 'Claimed the fix worked without running anything.',
      },
    ] as never as Parameters<typeof clusterKeys>[0]
    const keys = await clusterKeys(rows)
    expect([...new Set(keys.values())]).toEqual(['claimed-done-without-running'])
  })

  /**
   * The path that actually runs. Lexical similarity is the fallback and a weak
   * one — on two real headlines about the same config-schema mistake it scored
   * 0.333, which no threshold separates from unrelated pairs without also
   * splitting related ones.
   */
  it('uses embeddings to group headlines that share no vocabulary', async () => {
    const rows = [
      { id: 'a', mode: 'm', headline: 'Shipped the change without executing the suite.' },
      { id: 'b', mode: 'm', headline: 'Reported success though nothing was ever run.' },
      { id: 'c', mode: 'm', headline: 'Rewrote the whole module to alter one line.' },
    ] as never as Parameters<typeof clusterKeys>[0]

    // a and b mean the same thing and share no content words; c does not.
    const vectors: Record<string, number[]> = {
      'Shipped the change without executing the suite.': [1, 0, 0],
      'Reported success though nothing was ever run.': [0.95, 0.31, 0],
      'Rewrote the whole module to alter one line.': [0, 0, 1],
    }
    const embedder = {
      id: 'fake',
      model: 'fake',
      dim: 3,
      async embed(texts: string[]) {
        return texts.map((t) => Float32Array.from(vectors[t] ?? [0, 1, 0]))
      },
    }

    const keys = await clusterKeys(rows, { embedder })
    expect(keys.get('a')).toBe(keys.get('b'))
    expect(keys.get('c')).not.toBe(keys.get('a'))
  })

  /**
   * An empty token set matches nothing, so identical headlines whose every
   * word is a stopword each became their own cluster — the opposite of what
   * identical means, and it silently split a real fixture into seven groups.
   */
  it('merges identical headlines that have no content words at all', async () => {
    const rows = [
      { id: 'a', mode: 'm', headline: 'It did.' },
      { id: 'b', mode: 'm', headline: 'It did.' },
    ] as never as Parameters<typeof clusterKeys>[0]
    expect(new Set((await clusterKeys(rows)).values()).size).toBe(1)
  })

  it('is stable across runs', async () => {
    const rows = [
      { id: 'b', mode: 'm', headline: 'Rebuilt the artwork without the reference image at all.' },
      { id: 'a', mode: 'm', headline: 'Created four config types when only two were specified.' },
    ] as never as Parameters<typeof clusterKeys>[0]
    expect([...(await clusterKeys(rows))]).toEqual([...(await clusterKeys(rows))])
  })
})

describe('rankByRegret', () => {
  it('puts an expensive guardrail above a more confident procedure', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const db = await h.db()
      await seedSession(h, 'S0', transcript([SAID]))
      await extractCorrections(
        db,
        layout,
        defaults(),
        new MockLlm([{ corrections: [correction({ turns: 30 })] }]),
      )
      const ranked = rankByRegret(
        db,
        [
          { slug: 'a-procedure', confidence: 0.99, prevents: '' },
          { slug: 'the-guardrail', confidence: 0.6, prevents: 'claimed-done-without-running' },
        ],
        (r) => r.prevents,
      )
      expect(ranked.map((r) => r.slug)).toEqual(['the-guardrail', 'a-procedure'])
      expect(ranked[0]?.regret?.turns).toBe(30)
      expect(ranked[1]?.regret).toBeNull()
      h.close()
    } finally {
      await cleanup()
    }
  })
})

describe('mirror', () => {
  it('says how much of the corpus it has not read yet', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const db = await h.db()
      await seedSession(h, 'S0', transcript([SAID]), 2000)
      await seedSession(h, 'S1', transcript([SAID]), 1000)
      // Only one of the two gets a watermark.
      await extractCorrections(db, layout, defaults(), new MockLlm([{ corrections: [] }]), {
        limit: 1,
      })
      const m = await buildMirror(db, layout, defaults(), { modes: [], guardrails: [] })
      expect(m.markdown).toContain('Read from **1 of 2 sessions**')
      expect(m.markdown).toContain('1 sessions have not been read for corrections yet')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('quotes the person and names what the failure cost', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const db = await h.db()
      await seedSession(h, 'S0', transcript([SAID]))
      await extractCorrections(
        db,
        layout,
        defaults(),
        new MockLlm([{ corrections: [correction({ turns: 7 })] }]),
      )
      const modes = failureModes(db)
      const m = await buildMirror(db, layout, defaults(), {
        modes,
        guardrails: [
          {
            slug: 'run-before-reporting',
            mode: 'claimed-done-without-running',
            description: 'Use when about to report a change works.',
            body: '',
            turns: 7,
            sessions: 1,
          },
        ],
      })
      expect(m.empty).toBe(false)
      // The quote is the whole mechanism. A paraphrase reads as a horoscope.
      expect(m.markdown).toContain(SAID)
      // On a page arguing that every line is sourced, the one number in the
      // header must be the sessions actually read — not the store's total.
      expect(m.markdown).toContain('Read from **1 of 1 sessions**')
      expect(m.markdown).toContain('~7 turns')
      expect(m.markdown).toContain('hoppr skills install run-before-reporting')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('says nothing rather than something empty on a store with no sessions', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const m = await buildMirror(await h.db(), layout, defaults(), { modes: [], guardrails: [] })
      expect(m.empty).toBe(true)
      expect(m.path).toBeUndefined()
      h.close()
    } finally {
      await cleanup()
    }
  })
})
