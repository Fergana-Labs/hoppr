/**
 * Local OCR, ahead of any model call.
 *
 * Measured on a 720×220 screenshot of an error message: 765ms, free, and the
 * text was as usable as the vision model's. Paying a model per image to read
 * text a WASM binary reads for nothing is the wrong default — so OCR runs
 * first and the model, if configured at all, is only asked for what OCR cannot
 * give: what the image SHOWS.
 *
 * `tesseract.js` is WASM, so there is no native build to fail on someone
 * else's machine. It is optional: without it, images fall back to the model,
 * and without that, to being indexed by name.
 */
let workerPromise: Promise<unknown> | undefined

export interface OcrResult {
  text: string
  /** 0-100. Low confidence usually means an image with no text in it. */
  confidence: number
  available: boolean
}

/**
 * One worker for the process. Startup dominates the cost — creating one per
 * image would make a folder of screenshots pay it hundreds of times.
 */
async function getWorker(): Promise<
  { recognize: (i: string) => Promise<{ data: { text: string; confidence: number } }> } | undefined
> {
  if (!workerPromise) {
    workerPromise = (async () => {
      try {
        const { createWorker } = await import('tesseract.js')
        return await createWorker('eng')
      } catch {
        return undefined
      }
    })()
  }
  return (await workerPromise) as never
}

export async function ocrImage(path: string): Promise<OcrResult> {
  const worker = await getWorker()
  if (!worker) return { text: '', confidence: 0, available: false }
  try {
    const { data } = await worker.recognize(path)
    return {
      text: (data.text ?? '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim(),
      confidence: data.confidence ?? 0,
      available: true,
    }
  } catch {
    // A malformed image must not fail the sweep it was found in.
    return { text: '', confidence: 0, available: true }
  }
}

/**
 * Release the worker. Required for any short-lived process: tesseract runs in
 * a child, and an un-terminated one keeps the parent's event loop alive
 * indefinitely.
 */
export async function closeOcr(): Promise<void> {
  if (!workerPromise) return
  const w = (await workerPromise) as { terminate?: () => Promise<void> } | undefined
  workerPromise = undefined
  await w?.terminate?.().catch(() => {})
}

/**
 * OCR a PDF that has no text layer, by rasterising its pages.
 *
 * This is the scanned-document case: the file is text to a human and opaque to
 * every extractor. Capped at a few pages because a 300-page scan would take
 * minutes and the point is to make the document FINDABLE, not to transcribe it
 * completely.
 */
export async function ocrPdf(path: string, maxPages = 5): Promise<string> {
  const worker = await getWorker()
  if (!worker) return ''
  try {
    const [{ readFile }, unpdf] = await Promise.all([import('node:fs/promises'), import('unpdf')])
    const raw = await readFile(path)
    // pdf.js DETACHES the ArrayBuffer it is handed, so every call needs its own
    // copy. Reusing one silently yields a zero-length buffer and a blank page,
    // which looks exactly like "this scan has no text".
    const copy = () => new Uint8Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length))
    const doc = await unpdf.getDocumentProxy(copy())
    const total = doc.numPages ?? 1
    const pages = Math.min(total, maxPages)
    const out: string[] = []
    for (let p = 1; p <= pages; p++) {
      // Node has no DOM canvas, so pdf.js needs one supplied. @napi-rs/canvas
      // is an optional dependency: without it, rendering throws and a scanned
      // PDF stays indexed by name rather than failing the sync.
      const img = await unpdf.renderPageAsImage(copy(), p, {
        scale: 2,
        canvasImport: () => import('@napi-rs/canvas') as never,
      })
      const { data } = await worker.recognize(Buffer.from(img) as never)
      const text = (data.text ?? '').trim()
      if (text) out.push(text)
    }
    const joined = out.join('\n\n').trim()
    return total > pages && joined
      ? `${joined}\n\n[OCR covered the first ${pages} of ${total} pages.]`
      : joined
  } catch {
    return ''
  }
}
