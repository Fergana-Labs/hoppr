import type { Config } from '../config/schema.ts'
import type { Db } from '../db/driver.ts'
import { ClaudeCliProvider } from './claude-cli.ts'
import { HttpLlmProvider } from './http.ts'
import type { LlmProvider, Tier, Usage } from './provider.ts'
import { defaultTimeoutMs, modelsFor } from './provider.ts'

export { extractJson, parseJsonWithRepair } from './json.ts'
export type { LlmProvider, Tier, Usage } from './provider.ts'

/**
 * Resolve a provider, preferring cheap and fast over convenient.
 *
 * `auto` order: OpenRouter key → Anthropic key → the installed `claude` CLI →
 * none. API keys come first because the CLI carries ~11k cached prompt tokens
 * and 2-4 seconds of process overhead on every call, which is fine for a
 * nightly pass and painful for a backfill of thousands of sessions.
 *
 * Returning `undefined` is a first-class outcome, not an error: hoppr still
 * captures, indexes, and searches with no LLM at all. `npx hoppr` on a fresh
 * machine has to do something useful.
 */
/** Raw HTTP APIs, in the order `auto` prefers them. */
const HTTP_PROVIDERS = ['openrouter', 'anthropic', 'openai', 'ollama'] as const

/** Reaches a model by spawning a CLI, not by calling an API. */
export function isSubprocessProvider(id: string): boolean {
  return id === 'claude-cli' || id === 'claude-agent-sdk'
}

/**
 * Resolve a provider FOR A TIER.
 *
 * Tagging and extraction are the fast tier: one call per batch, run over the
 * whole corpus. They belong on a raw HTTP API — a request is sub-second and
 * costs a fraction of a cent. Routing them through the `claude` CLI instead
 * pays ~2-4s of process spawn and ~11k cached prompt tokens PER CALL, which
 * turns a backfill from model-bound into subprocess-bound.
 *
 * So `auto` tries every HTTP provider first and only falls back to the CLI —
 * and callers can ask whether they got the fallback, to warn about it. The CLI
 * path stays because it is the only one that needs no API key at all, and
 * `npx hoppr` working with zero setup is worth keeping.
 *
 * Returning `undefined` remains a first-class outcome: hoppr still captures,
 * indexes and searches with no model at all.
 */
export async function resolveLlm(
  cfg: Config,
  tier: Tier = 'quality',
  secrets: Record<string, string> = {},
): Promise<LlmProvider | undefined> {
  // Resolve models AFTER the provider is known, so each provider gets ids it
  // actually recognizes.
  const make = (id: string): LlmProvider => {
    const models = modelsFor(id, cfg.llm.models)
    const timeout = cfg.llm.timeout_ms ?? defaultTimeoutMs(id)
    return isSubprocessProvider(id)
      ? new ClaudeCliProvider(models, timeout)
      : new HttpLlmProvider(id, models, timeout, secrets)
  }

  const configured =
    (tier === 'fast' ? cfg.llm.fast_provider : cfg.llm.quality_provider) ?? cfg.llm.provider

  if (configured === 'none') return undefined
  if (configured !== 'auto') {
    const p = make(configured)
    return (await p.available()) ? p : undefined
  }

  for (const id of HTTP_PROVIDERS) {
    const p = make(id)
    if (await p.available()) return p
  }
  const cli = make('claude-cli')
  return (await cli.available()) ? cli : undefined
}

/** Cost accounting. `hoppr cost` reads this table; budgets enforce against it. */
export function recordCall(
  db: Db,
  provider: string,
  purpose: string,
  tier: string,
  usage: Usage,
  ok: boolean,
): void {
  db.prepare(
    `INSERT INTO llm_calls(at, provider, model, tier, purpose, input_tokens, output_tokens, cost_usd, ok, ms)
     VALUES (:at,:p,:m,:t,:pu,:i,:o,:c,:ok,:ms)`,
  ).run({
    at: Date.now(),
    p: provider,
    m: usage.model ?? null,
    t: tier,
    pu: purpose,
    i: usage.inputTokens ?? null,
    o: usage.outputTokens ?? null,
    c: usage.costUsd ?? null,
    ok: ok ? 1 : 0,
    ms: usage.ms ?? null,
  })
}

export function spendSince(db: Db, since: number): { calls: number; usd: number; tokens: number } {
  const r = db
    .prepare<{ calls: number; usd: number; tokens: number }>(
      `SELECT COUNT(*) calls,
              COALESCE(SUM(cost_usd),0) usd,
              COALESCE(SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)),0) tokens
         FROM llm_calls WHERE at >= :since`,
    )
    .get({ since })
  return r ?? { calls: 0, usd: 0, tokens: 0 }
}

/**
 * Hard daily cap. Checked before a batch, not after — the point is to stop
 * before the spend, and an autonomous nightly job is exactly the thing that
 * should not be able to surprise you with a bill.
 */
export function withinBudget(db: Db, cfg: Config): { ok: boolean; spent: number; cap: number } {
  const cap = cfg.curate.budget.max_usd_per_day
  const spent = spendSince(db, Date.now() - 86_400_000).usd
  return { ok: cap <= 0 || spent < cap, spent, cap }
}
