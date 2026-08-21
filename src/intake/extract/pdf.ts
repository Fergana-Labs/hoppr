import { readFile } from 'node:fs/promises'

/**
 * PDF text extraction, behind an optional dependency.
 *
 * `unpdf` bundles a PDF.js build; it is optional for the same reason the ONNX
 * embedder is. Without it a PDF is still captured and findable by name — the
 * file is never silently dropped, it just carries less text.
 *
 * Scanned PDFs have no text layer at all, so a near-empty result is normal
 * rather than a failure, and the caller falls through to describing the file
 * instead of writing a page that says nothing.
 */
export async function extractPdfText(path: string, maxChars = 200_000): Promise<string> {
  let mod: typeof import('unpdf')
  try {
    mod = await import('unpdf')
  } catch {
    return ''
  }
  const restore = quietCMapWarnings()
  try {
    const bytes = new Uint8Array(await readFile(path))
    const doc = await mod.getDocumentProxy(bytes)
    const { text } = await mod.extractText(doc, { mergePages: true })
    return normalize(String(text ?? '')).slice(0, maxChars)
  } catch {
    // A corrupt or encrypted PDF is a normal thing to find in a folder.
    return ''
  } finally {
    restore()
  }
}

/**
 * Silence one specific pdf.js warning, and nothing else.
 *
 * `unpdf` bundles pdf.js rather than depending on it, so its attempt to point
 * pdf.js at the CMap tables resolves `pdfjs-dist` and fails from any installed
 * copy of hoppr. Every PDF using a non-Latin or unusual font then prints
 * `translateFont failed … Ensure that the cMapUrl API parameter is provided`
 * onto a sync that is otherwise working.
 *
 * There is nothing the reader can do about it — they cannot supply a path we
 * cannot resolve — so it is noise rather than information. Matched narrowly on
 * purpose: any other pdf.js warning still reaches the console, because a
 * blanket mute is how a real failure goes missing.
 */
function quietCMapWarnings(): () => void {
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    const first = typeof args[0] === 'string' ? args[0] : ''
    if (first.includes('cMapUrl') || first.includes('translateFont')) return
    original(...(args as []))
  }
  return () => {
    console.warn = original
  }
}

/** PDF text layers arrive with broken line wrapping and stray hyphenation. */
export function normalize(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/-\n(?=[a-z])/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
