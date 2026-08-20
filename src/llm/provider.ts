import type { z } from 'zod'

export type Tier = 'fast' | 'quality'

export interface ImageInput {
  mediaType: string
  /** Base64, without a data: prefix. */
  base64: string
}

export interface CompleteOptions {
  prompt: string
  system?: string
  tier: Tier
  maxTokens?: number
  /** Tagged onto the llm_calls row so `hoppr cost` can break spend down. */
  purpose: string
  /**
   * Images to send alongside the prompt. Providers that cannot accept them
   * ignore the field rather than failing, so a caller can always offer them
   * and let the configured provider decide.
   */
  images?: ImageInput[]
}

export interface JsonOptions<T> extends CompleteOptions {
  schema: z.ZodType<T>
}

export interface Usage {
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  model?: string
  ms?: number
}

export interface LlmProvider {
  readonly id: string
  /**
   * Can this provider accept images?
   *
   * A provider that silently drops them does not fail — it answers the prompt
   * without the picture, and "I don't see an image attached" gets written into
   * the index as a description. A confident non-answer stored as data is worse
   * than no answer, so callers check this before offering images.
   */
  readonly supportsVision: boolean
  /** Cheap check: is this provider usable right now, without calling it? */
  available(): Promise<boolean>
  completeText(o: CompleteOptions): Promise<{ text: string; usage: Usage }>
  completeJson<T>(o: JsonOptions<T>): Promise<{ value: T; usage: Usage }>
}

export interface ModelMap {
  fast: string
  quality: string
}

/**
 * Per-provider defaults, so `auto` picking a provider never lands on a model
 * id that provider has never heard of. Verified against each provider's live
 * model list rather than guessed.
 */
export const DEFAULT_MODELS: Record<string, ModelMap> = {
  anthropic: { fast: 'claude-haiku-4-5-20251001', quality: 'claude-sonnet-5' },
  'claude-cli': { fast: 'claude-haiku-4-5-20251001', quality: 'claude-sonnet-5' },
  'claude-agent-sdk': { fast: 'claude-haiku-4-5-20251001', quality: 'claude-sonnet-5' },
  openrouter: { fast: 'anthropic/claude-haiku-4.5', quality: 'anthropic/claude-sonnet-5' },
  openai: { fast: 'gpt-5-mini', quality: 'gpt-5' },
  ollama: { fast: 'llama3.2', quality: 'llama3.2' },
}

/** Explicit config wins; otherwise the provider's own default. */
export function modelsFor(
  providerId: string,
  configured: { fast?: string; quality?: string },
): ModelMap {
  const base = DEFAULT_MODELS[providerId] ?? DEFAULT_MODELS.anthropic!
  return { fast: configured.fast ?? base.fast, quality: configured.quality ?? base.quality }
}

/**
 * A CLI subprocess reloads its whole context per call and runs ~3x the latency
 * of the equivalent HTTP request. Benchmarked on 19 real transcripts: the HTTP
 * path averaged 42s per batch of 8 while the CLI path exceeded 120s and lost 7
 * rows to timeouts that looked like model failures.
 */
export function defaultTimeoutMs(providerId: string): number {
  return isSubprocess(providerId) ? 300_000 : 120_000
}

function isSubprocess(id: string): boolean {
  return id === 'claude-cli' || id === 'claude-agent-sdk'
}

/**
 * Catch a configured model that this provider cannot possibly accept, so the
 * failure surfaces in `hoppr doctor` rather than at the first call of a
 * nightly pass. Naming conventions are the reliable signal: OpenRouter routes
 * by `vendor/model` and requires the slash; the first-party APIs reject one.
 *
 * This is deliberately shape-only. Checking against a live model list would
 * mean a network call in doctor and a false alarm every time a vendor ships a
 * model we have not heard of.
 */
export function modelMismatch(providerId: string, model: string): string | undefined {
  const slashed = model.includes('/')
  if (providerId === 'openrouter' && !slashed) {
    return `openrouter needs a 'vendor/model' id — '${model}' has no vendor prefix`
  }
  if ((providerId === 'anthropic' || providerId === 'openai') && slashed) {
    return `${providerId} does not accept routed ids — '${model}' looks like an OpenRouter slug`
  }
  return undefined
}

/**
 * Two tiers rather than model strings scattered through the codebase.
 *
 * FAST is per-item classification and tagging — high volume, low stakes,
 * cheapest model. QUALITY is the nightly synthesis, taxonomy convergence, and
 * skill mining, where being wrong compounds across the whole corpus. Anything
 * that has to pick a model picks a tier instead, so retuning is one config
 * change rather than a search-and-replace.
 */
export function modelFor(tier: Tier, models: ModelMap): string {
  return tier === 'fast' ? models.fast : models.quality
}
