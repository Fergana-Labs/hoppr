import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defaults } from '../src/config/schema.ts'
import { HttpLlmProvider } from '../src/llm/http.ts'
import { isSubprocessProvider, resolveLlm } from '../src/llm/index.ts'
import { modelsFor as modelsForSync } from '../src/llm/provider.ts'

const KEYS = ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const

afterEach(() => {
  for (const k of KEYS) delete process.env[k]
  vi.unstubAllGlobals()
})

/** Capture the outgoing request instead of making one. */
function mockFetch(reply: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(reply), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })
  return calls
}

const models = { fast: 'fast-model', quality: 'quality-model' }

describe('http provider wire format', () => {
  it('speaks the Anthropic dialect: x-api-key, top-level system, content blocks', async () => {
    process.env.ANTHROPIC_API_KEY = 'k-ant'
    const calls = mockFetch({
      content: [{ type: 'text', text: 'hello' }],
      usage: { input_tokens: 11, output_tokens: 3 },
    })
    const p = new HttpLlmProvider('anthropic', models)
    const r = await p.completeText({ prompt: 'hi', system: 'be brief', tier: 'fast', purpose: 't' })

    expect(r.text).toBe('hello')
    expect(r.usage).toMatchObject({ inputTokens: 11, outputTokens: 3, model: 'fast-model' })
    const { url, init } = calls[0]!
    expect(url).toContain('api.anthropic.com')
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('k-ant')
    const body = JSON.parse(String(init.body))
    expect(body.system).toBe('be brief') // top-level, not a message
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(body.model).toBe('fast-model') // the TIER picked the model
  })

  it('speaks the OpenAI dialect: bearer auth, system as a message', async () => {
    process.env.OPENAI_API_KEY = 'k-oai'
    const calls = mockFetch({
      choices: [{ message: { content: 'hey' } }],
      usage: { prompt_tokens: 7, completion_tokens: 2 },
    })
    const p = new HttpLlmProvider('openai', models)
    const r = await p.completeText({
      prompt: 'hi',
      system: 'be brief',
      tier: 'quality',
      purpose: 't',
    })

    expect(r.text).toBe('hey')
    expect(r.usage).toMatchObject({ inputTokens: 7, outputTokens: 2, model: 'quality-model' })
    const { url, init } = calls[0]!
    expect(url).toContain('api.openai.com')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k-oai')
    const body = JSON.parse(String(init.body))
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be brief' })
  })

  it('sends OpenRouter its attribution headers', async () => {
    process.env.OPENROUTER_API_KEY = 'k-or'
    const calls = mockFetch({ choices: [{ message: { content: 'ok' } }] })
    await new HttpLlmProvider('openrouter', models).completeText({
      prompt: 'hi',
      tier: 'fast',
      purpose: 't',
    })
    expect((calls[0]!.init.headers as Record<string, string>)['X-Title']).toBe('hoppr')
  })

  it('classifies failures so a sweep knows what to retry', async () => {
    process.env.OPENAI_API_KEY = 'k'
    for (const [status, kind] of [
      [429, 'transient'],
      [503, 'transient'],
      [400, 'terminal'],
      [401, 'terminal'],
    ] as const) {
      mockFetch({ error: 'nope' }, status)
      const p = new HttpLlmProvider('openai', models)
      await expect(
        p.completeText({ prompt: 'x', tier: 'fast', purpose: 't' }),
      ).rejects.toMatchObject({ kind })
    }
  })

  it('parses JSON through the fence stripper', async () => {
    process.env.OPENAI_API_KEY = 'k'
    mockFetch({ choices: [{ message: { content: '```json\n{"n": 4}\n```' } }] })
    const p = new HttpLlmProvider('openai', models)
    const r = await p.completeJson({
      prompt: 'x',
      tier: 'fast',
      purpose: 't',
      schema: z.object({ n: z.number() }),
    })
    expect(r.value.n).toBe(4)
  })

  it('refuses without its key rather than sending an unauthenticated request', async () => {
    const calls = mockFetch({})
    await expect(
      new HttpLlmProvider('openai', models).completeText({
        prompt: 'x',
        tier: 'fast',
        purpose: 't',
      }),
    ).rejects.toThrow(/OPENAI_API_KEY/)
    expect(calls).toHaveLength(0)
  })
})

describe('provider-specific model defaults', () => {
  it('gives each provider ids it actually recognizes', async () => {
    const { modelsFor } = await import('../src/llm/provider.ts')
    // A single shared default silently misconfigures whichever provider it was
    // not written for: OpenRouter has never heard of "claude-haiku-4-5".
    expect(modelsFor('anthropic', {}).fast).toBe('claude-haiku-4-5-20251001')
    expect(modelsFor('openrouter', {}).fast).toBe('anthropic/claude-haiku-4.5')
    expect(modelsFor('openai', {}).fast).toBe('gpt-5-mini')
  })

  it('lets explicit config win', () => {
    expect(modelsForSync('openrouter', { fast: 'google/gemini-3.7-flash' }).fast).toBe(
      'google/gemini-3.7-flash',
    )
  })

  it('resolves the model AFTER the provider, not before', async () => {
    process.env.OPENROUTER_API_KEY = 'k'
    const calls = mockFetch({ choices: [{ message: { content: 'ok' } }] })
    const p = await resolveLlm(defaults(), 'fast')
    await p!.completeText({ prompt: 'x', tier: 'fast', purpose: 't' })
    expect(JSON.parse(String(calls[0]!.init.body)).model).toBe('anthropic/claude-haiku-4.5')
  })
})

describe('tier-aware resolution', () => {
  it('puts TAGGING on a raw API, never on a CLI subprocess, when a key exists', async () => {
    process.env.ANTHROPIC_API_KEY = 'k'
    const fast = await resolveLlm(defaults(), 'fast')
    expect(fast?.id).toBe('anthropic')
    expect(isSubprocessProvider(fast!.id)).toBe(false)
  })

  it('prefers OpenRouter, then Anthropic, then OpenAI', async () => {
    process.env.OPENAI_API_KEY = 'k'
    expect((await resolveLlm(defaults(), 'fast'))?.id).toBe('openai')
    process.env.ANTHROPIC_API_KEY = 'k'
    expect((await resolveLlm(defaults(), 'fast'))?.id).toBe('anthropic')
    process.env.OPENROUTER_API_KEY = 'k'
    expect((await resolveLlm(defaults(), 'fast'))?.id).toBe('openrouter')
  })

  it('honours a per-tier override, so tagging can run on a cheap model', async () => {
    process.env.ANTHROPIC_API_KEY = 'k'
    process.env.OPENAI_API_KEY = 'k'
    const cfg = defaults()
    cfg.llm.fast_provider = 'openai'
    cfg.llm.quality_provider = 'anthropic'
    expect((await resolveLlm(cfg, 'fast'))?.id).toBe('openai')
    expect((await resolveLlm(cfg, 'quality'))?.id).toBe('anthropic')
  })

  it('returns nothing for provider = none, which must stay a first-class outcome', async () => {
    process.env.ANTHROPIC_API_KEY = 'k'
    const cfg = defaults()
    cfg.llm.provider = 'none'
    expect(await resolveLlm(cfg, 'fast')).toBeUndefined()
  })

  it('does not silently substitute a provider whose key is missing', async () => {
    const cfg = defaults()
    cfg.llm.provider = 'openai' // explicit, but no key set
    expect(await resolveLlm(cfg, 'fast')).toBeUndefined()
  })
})

describe('model/provider mismatch', () => {
  it('flags a first-party id sent to openrouter, and the reverse', async () => {
    const { modelMismatch } = await import('../src/llm/provider.ts')
    expect(modelMismatch('openrouter', 'claude-haiku-4-5-20251001')).toMatch(/vendor prefix/)
    expect(modelMismatch('anthropic', 'anthropic/claude-haiku-4.5')).toMatch(/routed ids/)
    expect(modelMismatch('openrouter', 'anthropic/claude-haiku-4.5')).toBeUndefined()
    expect(modelMismatch('anthropic', 'claude-haiku-4-5-20251001')).toBeUndefined()
    // ollama takes bare names and is not in the checked set.
    expect(modelMismatch('ollama', 'llama3.2')).toBeUndefined()
  })
})

describe('per-provider timeouts', () => {
  it('gives the subprocess path room the HTTP path does not need', async () => {
    const { defaultTimeoutMs } = await import('../src/llm/provider.ts')
    // Measured, not guessed: the CLI path lost 7 of 19 rows at 120s.
    expect(defaultTimeoutMs('claude-cli')).toBeGreaterThan(defaultTimeoutMs('openrouter'))
    expect(defaultTimeoutMs('openrouter')).toBe(120_000)
  })
})
