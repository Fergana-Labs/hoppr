import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { LlmProvider } from '../../llm/provider.ts'

const MEDIA: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

export const IMAGE_EXTS = Object.keys(MEDIA)

export function imageMediaType(path: string): string | undefined {
  return MEDIA[extname(path).toLowerCase()]
}

/**
 * A folder of real files is full of screenshots, diagrams and scanned pages,
 * and by default none of them are searchable by anything but filename.
 *
 * TWO extractors, in cost order:
 *
 *   1. Local OCR (tesseract WASM) — 765ms and free on a measured screenshot,
 *      and its text was as usable as the model's. This runs first and always.
 *   2. A vision model — asked only for what OCR cannot give: what the image
 *      SHOWS. Skipped entirely when no model is configured.
 *
 * The order matters more than it looks. Paying per image to read text a local
 * binary reads for nothing turns "index my Downloads folder" into a bill, and
 * a screenshot of an error message is useful precisely because the error text
 * is searchable — which OCR alone achieves.
 */
const PROMPT = `Describe this image in one short paragraph for a search index:
what it shows and what kind of image it is (screenshot, photo, diagram, chart,
scan). Do not transcribe text — that is already handled. No preamble, no
markdown, no commentary about detail you cannot make out.`

export interface ImageExtraction {
  text: string
  /** false ⇒ no vision-capable provider; the file is indexed by name only. */
  described: boolean
}

export async function describeImage(
  path: string,
  llm: LlmProvider | undefined,
  opts: { ocr?: boolean; maxBytes?: number } = {},
): Promise<ImageExtraction> {
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024
  const mediaType = imageMediaType(path)
  if (!mediaType) return { text: '', described: false }

  // 1. OCR first: free, local, and the half that has to be verbatim.
  const ocr =
    opts.ocr === false
      ? { text: '', confidence: 0, available: false }
      : await (await import('./ocr.ts')).ocrImage(path)
  // Tesseract returns noise at low confidence on images that hold no text.
  const ocrText = ocr.confidence >= 40 && ocr.text.length >= 8 ? ocr.text : ''

  // 2. The model, only if one is configured AND can actually see. A provider
  // that drops images answers anyway, and its guess would be stored as fact.
  let described = ''
  if (llm?.supportsVision) {
    let bytes: Buffer | undefined
    try {
      bytes = await readFile(path)
    } catch {
      bytes = undefined
    }
    // Well past where a model reads more detail, and base64 costs a third again.
    if (bytes && bytes.length > 0 && bytes.length <= maxBytes) {
      try {
        const { text } = await llm.completeText({
          prompt: PROMPT,
          tier: 'fast',
          purpose: 'extract.image',
          maxTokens: 512,
          images: [{ mediaType, base64: bytes.toString('base64') }],
        })
        described = text.trim()
      } catch {
        // One unreadable image must not fail the sweep it was found in.
      }
    }
  }

  const parts = [
    ocrText ? `Text in image:\n${ocrText}` : '',
    described ? `Description:\n${described}` : '',
  ].filter(Boolean)

  return { text: parts.join('\n\n'), described: parts.length > 0 }
}
