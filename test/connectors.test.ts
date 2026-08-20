import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaults } from '../src/config/schema.ts'
import { claudeCode } from '../src/connectors/claude-code.ts'
import { codex } from '../src/connectors/codex.ts'
import { openclaw } from '../src/connectors/openclaw.ts'
import { syncAll } from '../src/connectors/registry.ts'
import { renderTranscript, truncateMiddle } from '../src/connectors/render.ts'
import { parseLine, tailLines } from '../src/connectors/tail.ts'
import { Hoppr } from '../src/core/hoppr.ts'
import { DEFAULT_RULES, redact } from '../src/intake/redact.ts'
import { Layout } from '../src/store/layout.ts'
import { tempStore } from './helpers.ts'

const ctx = (config: Record<string, unknown> = {}) => ({
  cursor: undefined as unknown,
  config: { min_turns: 1, max_chars: 60_000, ...config },
  log: () => {},
})

function ccLines(sessionId: string, turns: number, ts = '2026-08-17T10:00:00.000Z') {
  const out = [
    JSON.stringify({ type: 'ai-title', title: 'A generated title', sessionId }),
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId }),
  ]
  for (let i = 0; i < turns; i++) {
    out.push(
      JSON.stringify({
        type: 'user',
        sessionId,
        cwd: '/Users/x/code/my-app',
        gitBranch: 'main',
        version: '2.1.0',
        timestamp: ts,
        message: { role: 'user', content: `question ${i}` },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId,
        timestamp: ts,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: `answer ${i}` },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
    )
  }
  return `${out.join('\n')}\n`
}

describe('tail reader', () => {
  it('never advances past the last complete newline', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const f = join(layout.root, 'log.jsonl')
      await writeFile(f, '{"a":1}\n{"a":2}\n{"a":3') // last line truncated, as in a live file
      const r = await tailLines(f)
      expect(r.lines).toHaveLength(2)
      // The partial line is left for the next poll rather than lost forever.
      expect(r.cursor.offset).toBe(16)

      await appendFile(f, '}\n{"a":4}\n')
      const r2 = await tailLines(f, r.cursor)
      expect(r2.lines).toEqual(['{"a":3}', '{"a":4}'])
    } finally {
      await cleanup()
    }
  })

  it('resets when the file shrinks, rather than reading from a stale offset', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const f = join(layout.root, 'log.jsonl')
      await writeFile(f, '{"a":1}\n{"a":2}\n')
      const r = await tailLines(f)
      await writeFile(f, '{"b":1}\n')
      const r2 = await tailLines(f, r.cursor)
      expect(r2.lines).toEqual(['{"b":1}'])
    } finally {
      await cleanup()
    }
  })

  it('tolerates garbage lines', () => {
    expect(parseLine('not json')).toBeUndefined()
    expect(parseLine('')).toBeUndefined()
    expect(parseLine('{"a":1}')).toEqual({ a: 1 })
  })
})

describe('claude-code connector', () => {
  it('reads a session, uses the generated title, and derives project from cwd', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const dir = join(layout.root, 'projects', '-Users-x-code-my-app')
      await mkdir(dir, { recursive: true })
      const f = join(dir, 'sess-1.jsonl')
      await writeFile(f, ccLines('sess-1', 3))

      const sources = await claudeCode.discover({ path: join(layout.root, 'projects') })
      expect(sources).toHaveLength(1)

      const r = await claudeCode.pull(sources[0]!, ctx())
      expect(r.items).toHaveLength(1)
      const item = r.items[0]!
      expect(item.externalId).toBe('claude-code:sess-1')
      expect(item.title).toBe('A generated title')
      // From the cwd on the line, NOT the lossy directory slug.
      expect(item.project).toBe('my-app')
      expect(item.body).toContain('question 0')
      expect(item.body).toContain('## Prompts')
    } finally {
      await cleanup()
    }
  })

  it('produces ONE record that grows, not a new one per poll', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const dir = join(layout.root, 'projects', '-Users-x-code-my-app')
      await mkdir(dir, { recursive: true })
      const f = join(dir, 'sess-2.jsonl')
      await writeFile(f, ccLines('sess-2', 2))
      const src = (await claudeCode.discover({ path: join(layout.root, 'projects') }))[0]!

      const first = await claudeCode.pull(src, ctx())
      expect(first.items).toHaveLength(1)

      // Nothing appended: a re-poll must emit nothing at all.
      const second = await claudeCode.pull(src, { ...ctx(), cursor: first.cursor })
      expect(second.items).toHaveLength(0)

      await appendFile(f, ccLines('sess-2', 1, '2026-08-17T11:00:00.000Z'))
      const third = await claudeCode.pull(src, { ...ctx(), cursor: second.cursor })
      expect(third.items).toHaveLength(1)
      expect(third.items[0]!.externalId).toBe('claude-code:sess-2')
    } finally {
      await cleanup()
    }
  })

  it('skips trivial sessions rather than paying to curate them', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const dir = join(layout.root, 'projects', '-p')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 's.jsonl'), ccLines('tiny', 1))
      const src = (await claudeCode.discover({ path: join(layout.root, 'projects') }))[0]!
      const r = await claudeCode.pull(src, ctx({ min_turns: 5 }))
      expect(r.items).toHaveLength(0)
    } finally {
      await cleanup()
    }
  })

  it('excludes subagent sidechains by default but counts them', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const dir = join(layout.root, 'projects', '-p')
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, 's.jsonl'),
        `${ccLines('sc', 2).trim()}\n${JSON.stringify({
          type: 'user',
          sessionId: 'sc',
          isSidechain: true,
          message: { role: 'user', content: 'SUBAGENT NOISE' },
        })}\n`,
      )
      const src = (await claudeCode.discover({ path: join(layout.root, 'projects') }))[0]!
      const r = await claudeCode.pull(src, ctx())
      expect(r.items[0]!.body).not.toContain('SUBAGENT NOISE')
      expect(r.items[0]!.body).toContain('subagent_turns_skipped')
    } finally {
      await cleanup()
    }
  })

  it('marks a session touched seconds ago as partial, so it is not curated yet', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const dir = join(layout.root, 'projects', '-p')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'live.jsonl'), ccLines('live', 2, new Date().toISOString()))
      const src = (await claudeCode.discover({ path: join(layout.root, 'projects') }))[0]!
      const r = await claudeCode.pull(src, ctx())
      expect(r.items[0]!.partial).toBe(true)
    } finally {
      await cleanup()
    }
  })
})

describe('codex connector', () => {
  it('deduplicates the user turn Codex writes twice', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const dir = join(layout.root, 'sessions', '2026', '08', '17')
      await mkdir(dir, { recursive: true })
      const id = '019e8cfc-7a6f-7701-b19f-97eb4a345130'
      const lines = [
        {
          timestamp: '2026-08-17T10:00:00Z',
          type: 'session_meta',
          payload: {
            id,
            cwd: '/Users/x/code/proj',
            cli_version: '0.136.0',
            model_provider: 'openai',
          },
        },
        {
          timestamp: '2026-08-17T10:00:01Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'do the thing' },
        },
        {
          timestamp: '2026-08-17T10:00:01Z',
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ text: 'do the thing' }] },
        },
        {
          timestamp: '2026-08-17T10:00:02Z',
          type: 'response_item',
          payload: { type: 'reasoning', content: 'INTERNAL THOUGHTS' },
        },
        {
          timestamp: '2026-08-17T10:00:03Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'done' },
        },
        {
          timestamp: '2026-08-17T10:00:04Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'thanks' },
        },
      ]
      await writeFile(
        join(dir, `rollout-2026-08-17T10-00-00-${id}.jsonl`),
        `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
      )
      const src = (await codex.discover({ path: layout.root }))[0]!
      const r = await codex.pull(src, ctx())
      const body = r.items[0]!.body

      // Prompts deliberately appear in BOTH sections, so twice is correct.
      // Four times would mean the event_msg/response_item pair was not deduped.
      expect((body.match(/do the thing/g) ?? []).length).toBe(2)
      const promptBlock = body.slice(body.indexOf('## Prompts'), body.indexOf('## Transcript'))
      expect((promptBlock.match(/do the thing/g) ?? []).length).toBe(1)
      expect(body).not.toContain('INTERNAL THOUGHTS') // reasoning is huge and internal
      expect(r.items[0]!.project).toBe('proj')
    } finally {
      await cleanup()
    }
  })

  it('prefers the manifest for change detection', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const dir = join(layout.root, 'sessions', '2026', '08', '17')
      await mkdir(dir, { recursive: true })
      const id = '019e8cfc-7a6f-7701-b19f-97eb4a345131'
      await writeFile(join(dir, `rollout-x-${id}.jsonl`), '')
      await writeFile(
        join(layout.root, 'session_index.jsonl'),
        `${JSON.stringify({ id, thread_name: 'Named thread', updated_at: '2026-08-17T12:00:00Z' })}\n`,
      )
      const sources = await codex.discover({ path: layout.root })
      expect(sources[0]!.label).toBe('Named thread')
      expect(sources[0]!.mtimeMs).toBe(Date.parse('2026-08-17T12:00:00Z'))
    } finally {
      await cleanup()
    }
  })
})

describe('openclaw connector', () => {
  it('reads a v3 session file', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const dir = join(layout.root, 'agents', 'main', 'sessions')
      await mkdir(dir, { recursive: true })
      const lines = [
        {
          type: 'session',
          version: 3,
          id: 'oc-1',
          timestamp: '2026-08-17T10:00:00Z',
          cwd: '/Users/x/work/thing',
        },
        { type: 'model_change', provider: 'openai-codex', modelId: 'gpt-5.4' },
        {
          type: 'message',
          role: 'user',
          content: 'hello there',
          timestamp: '2026-08-17T10:00:01Z',
        },
        { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        { type: 'unknown_future_type', whatever: true },
      ]
      await writeFile(
        join(dir, 'oc-1.jsonl'),
        `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
      )
      const src = (await openclaw.discover({ path: join(layout.root, 'agents') }))[0]!
      const r = await openclaw.pull(src, ctx())
      expect(r.items[0]!.externalId).toBe('openclaw:oc-1')
      expect(r.items[0]!.project).toBe('thing')
      expect(r.items[0]!.body).toContain('hello there')
    } finally {
      await cleanup()
    }
  })
})

describe('transcript rendering', () => {
  it('keeps every prompt even when the budget forces truncation', () => {
    const turns = Array.from({ length: 200 }, (_, i) => ({
      role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
      text: i % 2 ? 'x'.repeat(500) : `PROMPT ${i}`,
    }))
    const out = renderTranscript({ id: 's' }, turns, { maxChars: 3000 })
    expect(out).toContain('PROMPT 0')
    expect(out).toContain('PROMPT 198')
    expect(out).toContain('elided')
  })

  it('truncates from the middle, keeping start and end', () => {
    const s = `START${'x'.repeat(5000)}END`
    const t = truncateMiddle(s, 1000)
    expect(t.startsWith('START')).toBe(true)
    expect(t.endsWith('END')).toBe(true)
  })
})

describe('redaction', () => {
  const SAMPLES: Array<[string, string]> = [
    ['anthropic-key', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['github-token', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'],
    ['aws-access-key', 'AKIAIOSFODNN7EXAMPLE'],
    ['slack-token', 'xoxb-123456789012-abcdefghijkl'],
    ['stripe-key', 'sk_live_abcdefghijklmnop1234'],
    ['openrouter-key', `sk-or-v1-${'a'.repeat(64)}`],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijklmno'],
  ]

  for (const [name, sample] of SAMPLES) {
    it(`scrubs a ${name}`, () => {
      const r = redact(`before ${sample} after`)
      expect(r.text).not.toContain(sample)
      expect(r.text).toContain('before')
      expect(r.text).toContain('after')
      expect(r.redacted).toBe(true)
    })
  }

  it('keeps the variable name so the text still reads', () => {
    const r = redact('export DATABASE_PASSWORD=hunter2hunter2hunter2')
    expect(r.text).toContain('DATABASE_PASSWORD')
    expect(r.text).not.toContain('hunter2hunter2hunter2')
  })

  it('scrubs credentials embedded in a URL but keeps the scheme', () => {
    const r = redact('postgres://admin:s3cr3tpassword@db.example.com/app')
    expect(r.text).toContain('postgres://')
    expect(r.text).not.toContain('s3cr3tpassword')
  })

  it('leaves ordinary prose completely alone', () => {
    const prose = 'We chose RRF at k=60 because bm25 and cosine live on different scales.'
    expect(redact(prose).text).toBe(prose)
    expect(redact(prose).redacted).toBe(false)
  })

  it('can be turned off', () => {
    const s = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    expect(redact(s, { enabled: false }).text).toBe(s)
  })

  it('survives a malformed user pattern instead of failing every ingest', () => {
    expect(() => redact('text', { extraPatterns: ['([unclosed'] })).not.toThrow()
  })

  it('has no rule that matches the empty string', () => {
    // A zero-width rule would loop or blank the document.
    for (const rule of DEFAULT_RULES) {
      expect(new RegExp(rule.re.source).test('')).toBe(false)
    }
  })
})

describe('sync pipeline', () => {
  it('captures once, updates in place, and scrubs before writing', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const projects = join(layout.root, 'fixture-claude')
      const dir = join(projects, '-Users-x-code-app')
      await mkdir(dir, { recursive: true })
      const secret = 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
      await writeFile(
        join(dir, 'sess.jsonl'),
        ccLines('sync-1', 2).replace('question 0', `here is my key ${secret}`),
      )

      const cfg = defaults()
      // A hoppr pulls from ITS source. Declaring it is what keeps a folder
      // hoppr from quietly ingesting your agent history.
      cfg.hopper.source = 'agents:claude-code'
      cfg.connectors = {
        'claude-code': { enabled: true, path: projects, min_turns: 1 } as never,
      }
      const h = new Hoppr({ layout: new Layout(layout.root), config: cfg, sources: [] })
      const db = await h.db()

      const first = await syncAll(db, layout, cfg, { full: true })
      const cc = first.find((s) => s.connector === 'claude-code')!
      expect(cc.captured).toBe(1)
      expect(cc.redacted).toBe(1)

      const stored = db.prepare<{ text: string }>('SELECT text FROM raw').get()!
      expect(stored.text).not.toContain(secret)
      expect(stored.text).toContain('«redacted:anthropic-key»')

      // Re-sync with nothing changed: no duplicate record.
      const second = await syncAll(db, layout, cfg, { full: true })
      expect(second.find((s) => s.connector === 'claude-code')!.captured).toBe(0)
      expect(db.prepare<{ n: number }>('SELECT COUNT(*) n FROM raw').get()!.n).toBe(1)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('reports what it skipped rather than implying it synced everything', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const projects = join(layout.root, 'fixture2')
      const dir = join(projects, '-p')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'old.jsonl'), ccLines('old', 2))

      const cfg = defaults()
      cfg.hopper.source = 'agents:claude-code'
      cfg.connectors = { 'claude-code': { enabled: true, path: projects, min_turns: 1 } as never }
      const h = new Hoppr({ layout: new Layout(layout.root), config: cfg, sources: [] })
      const db = await h.db()
      // A window in the future: everything is outside it.
      const stats = await syncAll(db, layout, cfg, { since: Date.now() + 86_400_000 })
      expect(stats[0]!.outsideWindow).toBe(1)
      expect(stats[0]!.captured).toBe(0)
      h.close()
    } finally {
      await cleanup()
    }
  })
})
