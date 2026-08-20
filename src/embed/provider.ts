import type { Config } from '../config/schema.ts'
import { HopprError } from '../core/errors.ts'
import { embeddingsEnabled } from '../core/profiles.ts'

export interface Embedder {
  readonly id: string
  readonly model: string
  readonly dim: number
  embed(texts: string[]): Promise<Float32Array[]>
  /** Called before first use so a model download is explicit, never a surprise. */
  warmup?(onProgress?: (msg: string) => void): Promise<void>
}

/**
 * Embeddings are a SEPARATE abstraction from the chat LLM, and that is not an
 * accident of layering — it is a hole in the obvious design worth naming.
 * Neither the Claude Agent SDK nor Anthropic ships an embeddings endpoint, and
 * OpenRouter is chat-completions only. So the default is local ONNX: no API
 * key, no per-item cost, nothing leaves the machine. Which is the right
 * default for a local-first tool regardless.
 */
export async function resolveEmbedder(cfg: Config): Promise<Embedder | undefined> {
  // One predicate, so "the preset says no vectors" and "no provider is
  // configured" cannot disagree — the failure mode being an embedder that
  // loads a 200MB model for a hoppr that will never use it.
  if (!embeddingsEnabled(cfg)) return undefined
  if (cfg.embed.provider === 'local') {
    const { LocalEmbedder } = await import('./local.ts')
    return new LocalEmbedder(cfg.embed.model, cfg.embed.dim)
  }
  const { RemoteEmbedder } = await import('./remote.ts')
  return new RemoteEmbedder(cfg.embed.provider, cfg.embed.model, cfg.embed.dim)
}

/**
 * Every provider emits the SAME dimension (384 by default), truncating and
 * renormalizing longer vectors. vec0 columns are fixed-width, so a provider
 * swap would otherwise be a schema migration plus a full re-embed of the
 * entire corpus. Matryoshka-trained models (OpenAI's v3 family, Voyage) are
 * explicitly designed to survive this; for others it is a mild quality cost
 * in exchange for never being locked to the first model you tried.
 */
export function fitDimension(vec: Float32Array, dim: number): Float32Array {
  if (vec.length === dim) return normalize(vec)
  if (vec.length < dim) {
    throw HopprError.user(
      `embedding model returned ${vec.length} dims but ${dim} are configured — ` +
        `set [embed] dim = ${vec.length}, then run \`hoppr reindex --full\``,
    )
  }
  return normalize(vec.subarray(0, dim))
}

export function normalize(vec: Float32Array): Float32Array {
  let sum = 0
  for (const v of vec) sum += v * v
  const norm = Math.sqrt(sum)
  if (norm === 0 || !Number.isFinite(norm)) return new Float32Array(vec)
  const out = new Float32Array(vec.length)
  for (let i = 0; i < vec.length; i++) out[i] = vec[i]! / norm
  return out
}

export function toBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)
}

export function fromBlob(blob: Uint8Array): Float32Array {
  // Copy: the source may be a view into a reused SQLite buffer.
  const copy = new Uint8Array(blob.byteLength)
  copy.set(blob)
  return new Float32Array(copy.buffer)
}

/**
 * Bind an integer for a `vec0` table.
 *
 * Both SQLite drivers bind plain JS numbers with REAL affinity, and vec0
 * rejects a REAL for its primary key and for INTEGER metadata columns
 * ("Only integers are allows for primary key values"). The failure is
 * per-row and easy to swallow, which would leave vector search silently
 * returning nothing while everything else looked healthy — so every integer
 * bound to vec_chunks goes through here.
 */
export function vecInt(n: number): bigint {
  return BigInt(Math.trunc(n))
}
