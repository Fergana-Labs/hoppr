import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { readZip } from './zip.ts'

export const OFFICE_EXTS = ['.docx', '.xlsx', '.pptx']
/** Pre-2007 binary formats. Recognised so we can say why, not silently skip. */
export const LEGACY_OFFICE_EXTS = ['.doc', '.xls', '.ppt']

/**
 * Text out of Word, Excel and PowerPoint.
 *
 * All three are ZIPs of XML, so this is unzip plus tag-stripping — no format
 * library, no native build. What each one needs from its XML differs enough to
 * be worth handling separately: paragraph breaks in Word are structural, and
 * Excel keeps most of its strings in a single shared table rather than in the
 * cells.
 */
export async function extractOfficeText(path: string, maxChars = 400_000): Promise<string> {
  const ext = extname(path).toLowerCase()
  let buf: Buffer
  try {
    buf = await readFile(path)
  } catch {
    return ''
  }
  try {
    if (ext === '.docx') {
      // mammoth understands the parts of the format worth having and the
      // hand-rolled reader does not: table rows survive as rows, and footnote
      // bodies (which live in a different XML part entirely) come through.
      // Measured on a fixture with both — the fallback loses both.
      const viaLib = await docxViaMammoth(path)
      return (viaLib || docx(buf)).slice(0, maxChars)
    }
    if (ext === '.xlsx') return xlsx(buf).slice(0, maxChars)
    if (ext === '.pptx') return pptx(buf).slice(0, maxChars)
  } catch {
    // A corrupt or password-protected document is a normal thing to find.
  }
  return ''
}

async function docxViaMammoth(path: string): Promise<string> {
  try {
    const mammoth = await import('mammoth')
    const { value } = await mammoth.convertToHtml({ path })
    return htmlToText(value)
  } catch {
    // Optional dependency, or a document it refuses: fall through.
    return ''
  }
}

/** HTML → text, keeping the row structure a table exists for. */
function htmlToText(html: string): string {
  return clean(
    html
      // Each cell wraps its content in <p>, which sits between the cell
      // boundaries and stops them ever being adjacent. Unwrap first, or every
      // table flattens to one value per line and the rows are lost.
      .replace(/<t([dh])([^>]*)>\s*<p[^>]*>/gi, '<t$1$2>')
      .replace(/<\/p>\s*<\/t([dh])>/gi, '</t$1>')
      .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, '\t')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|table|tr)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n'),
  )
}

function docx(buf: Buffer): string {
  const entries = readZip(buf, (n) => n === 'word/document.xml' || n.startsWith('word/header'))
  const main = entries.find((e) => e.name === 'word/document.xml')
  if (!main) return ''
  const xml = main.data.toString('utf8')
  // Paragraph and break tags carry the only line structure the document has;
  // without them a ten-page report collapses into one unreadable line.
  return clean(
    xml
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<w:tab[^>]*\/>/g, '\t'),
  )
}

/**
 * Excel stores a date as a NUMBER — days since 1899-12-30 — and records that it
 * is a date only in the cell's style. Without resolving that, a column of dates
 * indexes as `45678`, which no one will ever search for.
 */
const DATE_FMT_IDS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57, 58])

function excelSerialToDate(n: number): string | undefined {
  if (!Number.isFinite(n) || n <= 0 || n > 60_000) return undefined
  const ms = Math.round((n - 25_569) * 86_400_000)
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return undefined
  const iso = d.toISOString()
  // A whole number is a date; a fraction carries a time of day too.
  return Number.isInteger(n) ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ')
}

/** Which style indexes point at a date format. */
function dateStyles(stylesXml: string | undefined): Set<number> {
  const out = new Set<number>()
  if (!stylesXml) return out
  const custom = new Set<number>()
  for (const m of stylesXml.matchAll(/<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
    if (/[dmy]/i.test(m[2] ?? '') && !/[#0]/.test(m[2] ?? '')) custom.add(Number(m[1]))
  }
  const block = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? ''
  let i = 0
  for (const xf of block.matchAll(/<xf[^>]*numFmtId="(\d+)"[^>]*>?/g)) {
    const id = Number(xf[1])
    if (DATE_FMT_IDS.has(id) || custom.has(id)) out.add(i)
    i++
  }
  return out
}

function xlsx(buf: Buffer): string {
  const entries = readZip(
    buf,
    (n) =>
      n === 'xl/sharedStrings.xml' ||
      n === 'xl/workbook.xml' ||
      n === 'xl/styles.xml' ||
      /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
  )
  const dateXf = dateStyles(entries.find((e) => e.name === 'xl/styles.xml')?.data.toString('utf8'))
  // Cells hold indexes into this table, not the strings themselves.
  const sharedXml = entries.find((e) => e.name === 'xl/sharedStrings.xml')?.data.toString('utf8')
  const shared = sharedXml
    ? [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => clean(m[1] ?? ''))
    : []

  const names = [
    ...(entries.find((e) => e.name === 'xl/workbook.xml')?.data.toString('utf8') ?? '').matchAll(
      /<sheet[^>]*name="([^"]*)"/g,
    ),
  ].map((m) => m[1] ?? '')

  const sheets = entries
    .filter((e) => e.name.startsWith('xl/worksheets/'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

  const out: string[] = []
  sheets.forEach((sheet, i) => {
    const xml = sheet.data.toString('utf8')
    const rows: string[] = []
    for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = []
      // Capture the attribute block and the body separately. Reading `t="s"`
      // from a single combined pattern lets the trailing wildcard swallow the
      // attribute, and the cell then yields its shared-string INDEX instead of
      // its text — numbers where every label should be.
      for (const cell of (rowMatch[1] ?? '').matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1] ?? ''
        const inner = cell[2] ?? ''
        const type = /\bt="([^"]*)"/.exec(attrs)?.[1]
        const style = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? -1)
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]
        if (type === 's' && v !== undefined) cells.push(shared[Number(v)] ?? '')
        else if (type === 'inlineStr' || type === 'str') cells.push(clean(inner))
        else if (v !== undefined) {
          const asDate = dateXf.has(style) ? excelSerialToDate(Number(v)) : undefined
          cells.push(asDate ?? clean(v))
        } else cells.push('')
      }
      const line = cells.join('\t').replace(/\t+$/, '').trim()
      if (line) rows.push(line)
    }
    if (rows.length) out.push(`## ${names[i] || `Sheet${i + 1}`}\n${rows.join('\n')}`)
  })
  return out.join('\n\n')
}

function pptx(buf: Buffer): string {
  const slides = readZip(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  )
  return slides
    .map((s, i) => {
      const text = clean(s.data.toString('utf8').replace(/<\/a:p>/g, '\n'))
      return text ? `## Slide ${i + 1}\n${text}` : ''
    })
    .filter(Boolean)
    .join('\n\n')
}

/** Strip tags and decode the five XML entities. */
function clean(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
