import { HopprError } from '../core/errors.ts'
import { type Embedder, fitDimension } from './provider.ts'

interface Endpoint {
  url: string
  key: string
  body: (model: string, input: string[]) => unknown
  pick: (json: unknown) => number[][]
}

const ENDPOINTS: Record<string, Endpoint> = {
  openai: {
    url: 'https://api.openai.com/v1/embeddings',
    key: 'OPENAI_API_KEY',
    body: (model, input) => ({ model, input }),
    pick: (j) => (j as { data: { embedding: number[] }[] }).data.map((d) => d.embedding),
  },
  voyage: {
    url: 'https://api.voyageai.com/v1/embeddings',
    key: 'VOYAGE_API_KEY',
    body: (model, input) => ({ model, input, input_type: 'document' }),
    pick: (j) => (j as { data: { embedding: number[] }[] }).data.map((d) => d.embedding),
  },
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    key: 'GEMINI_API_KEY',
    body: (model, input) => ({ model, input }),
    pick: (j) => (j as { embeddings: { values: number[] }[] }).embeddings.map((e) => e.values),
  },
}

/** Remote embedders exist for quality; local stays the default for privacy and cost. */
export class RemoteEmbedder implements Embedder {
  readonly id: string
  readonly model: string
  readonly dim: number
  readonly #ep: Endpoint

  constructor(provider: string, model: string, dim: number) {
    const ep = ENDPOINTS[provider]
    if (!ep) throw HopprError.user(`unknown embedding provider '${provider}'`)
    this.id = provider
    this.model = model
    this.dim = dim
    this.#ep = ep
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    const key = process.env[this.#ep.key]
    if (!key) {
      throw HopprError.user(
        `${this.id} embeddings need ${this.#ep.key}. ` +
          'Set [embed] provider = "local" to run without any API key.',
      )
    }
    const res = await fetch(this.#ep.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(this.#ep.body(this.model, texts)),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      // 429 and 5xx are worth retrying; a 400 means this row will never succeed.
      const kind = res.status === 429 || res.status >= 500 ? 'transient' : 'terminal'
      throw new HopprError(
        kind,
        `${this.id} embeddings failed (${res.status}): ${detail.slice(0, 200)}`,
      )
    }
    return this.#ep.pick(await res.json()).map((v) => fitDimension(Float32Array.from(v), this.dim))
  }
}
