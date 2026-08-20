import { HopprError } from '../core/errors.ts'
import { type Embedder, fitDimension } from './provider.ts'

type Pipeline = (
  texts: string[],
  opts: { pooling: 'mean' | 'cls'; normalize: boolean },
) => Promise<{ dims: number[]; data: Float32Array | number[] }>

/**
 * Local ONNX embeddings. No API key, no per-item cost, nothing leaves the
 * machine — the right default for a local-first tool.
 *
 * The backend lives in optionalDependencies because the ONNX runtime is ~200MB
 * and most of what hoppr does (capture, the wiki, keyword search, MCP) works
 * without it. A missing backend degrades to keyword-only search with a clear
 * message, never a crash.
 */
export class LocalEmbedder implements Embedder {
  readonly id = 'local'
  readonly model: string
  readonly dim: number
  #pipe?: Pipeline

  constructor(model: string, dim: number) {
    this.model = model
    this.dim = dim
  }

  async warmup(onProgress?: (msg: string) => void): Promise<void> {
    if (this.#pipe) return
    let mod: typeof import('@huggingface/transformers')
    try {
      mod = await import('@huggingface/transformers')
    } catch {
      throw HopprError.user(
        'local embeddings need the ONNX backend:\n' +
          '  npm i -g @huggingface/transformers\n' +
          'Or set [embed] provider = "none" to use keyword search only.',
      )
    }
    let lastPct = -1
    this.#pipe = (await mod.pipeline('feature-extraction', this.model, {
      dtype: 'q8',
      progress_callback: (p: { status?: string; progress?: number; file?: string }) => {
        if (!onProgress) return
        if (p.status === 'progress' && typeof p.progress === 'number') {
          const pct = Math.floor(p.progress / 10) * 10
          if (pct !== lastPct) {
            lastPct = pct
            onProgress(`downloading ${p.file ?? this.model} ${pct}%`)
          }
        } else if (p.status === 'ready') {
          onProgress(`model ready: ${this.model}`)
        }
      },
    })) as unknown as Pipeline
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    await this.warmup()
    const out = await this.#pipe!(texts, { pooling: 'mean', normalize: true })
    const width = out.dims[out.dims.length - 1]!
    const flat = out.data instanceof Float32Array ? out.data : Float32Array.from(out.data)
    const vecs: Float32Array[] = []
    for (let i = 0; i < texts.length; i++) {
      vecs.push(fitDimension(flat.slice(i * width, (i + 1) * width), this.dim))
    }
    return vecs
  }
}

export async function localBackendAvailable(): Promise<boolean> {
  try {
    await import('@huggingface/transformers')
    return true
  } catch {
    return false
  }
}
