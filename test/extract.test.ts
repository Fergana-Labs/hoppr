import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { parseDotEnv } from '../src/config/env.ts'
import { extractOfficeText } from '../src/intake/extract/office.ts'
import { normalize } from '../src/intake/extract/pdf.ts'
import { readZip } from '../src/intake/extract/zip.ts'

/** Build a real ZIP so the reader is tested against bytes, not a mock. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8')
    const raw = Buffer.from(content, 'utf8')
    const comp = deflateRawSync(raw)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(8, 8) // deflate
    lh.writeUInt32LE(comp.length, 18)
    lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    locals.push(lh, nameBuf, comp)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(8, 10)
    ch.writeUInt32LE(comp.length, 20)
    ch.writeUInt32LE(raw.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt32LE(offset, 42)
    central.push(ch, nameBuf)
    offset += 30 + nameBuf.length + comp.length
  }
  const localBuf = Buffer.concat(locals)
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(localBuf.length, 16)
  return Buffer.concat([localBuf, centralBuf, eocd])
}

function write(name: string, buf: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'hoppr-office-'))
  const path = join(dir, name)
  writeFileSync(path, buf)
  return path
}

describe('zip reader', () => {
  it('reads named entries out of a real archive', () => {
    const entries = readZip(zip({ 'a.txt': 'hello', 'b.txt': 'world' }))
    expect(entries.map((e) => e.data.toString())).toEqual(['hello', 'world'])
  })

  it('returns nothing for a file that is not a zip', () => {
    expect(readZip(Buffer.from('not a zip at all'))).toEqual([])
  })
})

describe('office extraction', () => {
  it('keeps paragraph structure in docx', async () => {
    const doc = `<w:document><w:body>
      <w:p><w:r><w:t>Title</w:t></w:r></w:p>
      <w:p><w:r><w:t>First half </w:t></w:r><w:r><w:t>second half.</w:t></w:r></w:p>
    </w:body></w:document>`
    const path = write('a.docx', zip({ 'word/document.xml': doc }))
    const text = await extractOfficeText(path)
    // Runs inside one paragraph join; paragraphs stay separate lines.
    expect(text).toContain('First half second half.')
    expect(text.split('\n').filter(Boolean)).toHaveLength(2)
  })

  it('resolves xlsx shared strings instead of emitting their indexes', async () => {
    // The bug this guards: `t="s"` read from a combined pattern got swallowed,
    // so every label came out as the number of its slot in the string table.
    const shared = '<sst><si><t>Provider</t></si><si><t>openrouter</t></si></sst>'
    const sheet = `<worksheet><sheetData>
      <row><c r="A1" t="s"><v>0</v></c></row>
      <row><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42</v></c></row>
    </sheetData></worksheet>`
    const path = write(
      'a.xlsx',
      zip({
        'xl/workbook.xml': '<workbook><sheets><sheet name="Bench"/></sheets></workbook>',
        'xl/sharedStrings.xml': shared,
        'xl/worksheets/sheet1.xml': sheet,
      }),
    )
    const text = await extractOfficeText(path)
    expect(text).toContain('Provider')
    expect(text).toContain('openrouter\t42')
    expect(text).not.toMatch(/^0$/m)
  })

  it('numbers pptx slides', async () => {
    const slide = '<p:sld><a:p><a:r><a:t>Only slide</a:t></a:r></a:p></p:sld>'
    const path = write('a.pptx', zip({ 'ppt/slides/slide1.xml': slide }))
    expect(await extractOfficeText(path)).toContain('## Slide 1')
  })

  it('returns empty for a corrupt document rather than throwing', async () => {
    const path = write('bad.docx', Buffer.from('garbage'))
    await expect(extractOfficeText(path)).resolves.toBe('')
  })
})

describe('pdf normalize', () => {
  it('rejoins words broken across a line by hyphenation', () => {
    expect(normalize('recipro-\ncal rank fusion')).toBe('reciprocal rank fusion')
  })
})

describe('dotenv parsing', () => {
  it('handles quotes, export prefixes and trailing comments', () => {
    const env = parseDotEnv(
      [
        '# a comment',
        'export OPENROUTER_API_KEY=sk-or-v1-abc',
        'ANTHROPIC_API_KEY="sk-ant-quoted"',
        "OPENAI_API_KEY='sk-single'",
        'WITH_COMMENT=value   # trailing',
        'not a valid line',
      ].join('\n'),
    )
    expect(env.OPENROUTER_API_KEY).toBe('sk-or-v1-abc')
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-quoted')
    expect(env.OPENAI_API_KEY).toBe('sk-single')
    expect(env.WITH_COMMENT).toBe('value')
  })

  it('keeps a # that is inside a quoted secret', () => {
    expect(parseDotEnv('K="abc#def"').K).toBe('abc#def')
  })
})

describe('docx via mammoth', () => {
  it('keeps table rows as rows and pulls in footnote bodies', async () => {
    // Both are lost by the dependency-free fallback: a footnote body lives in
    // a different XML part entirely, and each table cell wraps its text in a
    // <p> that stops cell boundaries ever being adjacent.
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    const doc = `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body>
      <w:p><w:r><w:t>Budget Review</w:t></w:r></w:p>
      <w:tbl>
        <w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc>
             <w:tc><w:p><w:r><w:t>Cost</w:t></w:r></w:p></w:tc></w:tr>
        <w:tr><w:tc><w:p><w:r><w:t>Compute</w:t></w:r></w:p></w:tc>
             <w:tc><w:p><w:r><w:t>4200</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>
      <w:p><w:r><w:t>See footnote.</w:t></w:r><w:footnoteReference w:id="2"/></w:p>
    </w:body></w:document>`
    const fn = `<?xml version="1.0"?><w:footnotes xmlns:w="${W}"><w:footnote w:id="2"><w:p><w:r>
      <w:t>Excludes Q4 reserved instances.</w:t></w:r></w:p></w:footnote></w:footnotes>`
    const path = write('t.docx', zip({ 'word/document.xml': doc, 'word/footnotes.xml': fn }))
    const text = await extractOfficeText(path)
    expect(text).toContain('Budget Review')
    expect(text).toMatch(/Item\tCost/)
    expect(text).toMatch(/Compute\t4200/)
    expect(text).toContain('Excludes Q4 reserved instances')
  })
})

describe('xlsx dates', () => {
  it('resolves a date serial rather than indexing the number', async () => {
    // Excel stores dates as days since 1899-12-30 and records date-ness only
    // in the cell style. Unresolved, a date column indexes as `45678`.
    const sheet = `<worksheet><sheetData>
      <row><c r="A1" s="1"><v>45678</v></c><c r="B1"><v>8400</v></c></row>
    </sheetData></worksheet>`
    const styles =
      '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>'
    const path = write(
      'd.xlsx',
      zip({
        'xl/workbook.xml': '<workbook><sheets><sheet name="S"/></sheets></workbook>',
        'xl/worksheets/sheet1.xml': sheet,
        'xl/styles.xml': styles,
      }),
    )
    const text = await extractOfficeText(path)
    expect(text).toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(text).not.toContain('45678')
    // An unstyled number is still a number, not a date.
    expect(text).toContain('8400')
  })
})

describe('shadow extractions', () => {
  it('covers every type whose extraction is expensive', async () => {
    // Images were shadowed and PDFs were not, so `reindex` re-parsed every PDF
    // and re-ran OCR over every scanned page — the most expensive path here.
    const { IMAGE_EXTS } = await import('../src/intake/extract/image.ts')
    const { OFFICE_EXTS } = await import('../src/intake/extract/office.ts')
    const { readFile } = await import('node:fs/promises')
    const dir = await readFile('src/connectors/dir.ts', 'utf8')
    const registry = await readFile('src/connectors/registry.ts', 'utf8')

    // Read side: the reuse check must cover them.
    expect(dir).toContain('EXPENSIVE_EXTS')
    for (const ext of [...IMAGE_EXTS, ...OFFICE_EXTS, '.pdf']) {
      const covered =
        dir.includes('IMAGE_EXTS') && dir.includes('OFFICE_EXTS') && dir.includes("'.pdf'")
      expect(covered, `${ext} not in the reuse set`).toBe(true)
    }
    // Write side: the shadow must be written for them, not only for images.
    expect(registry).toContain('OFFICE_EXTS')
    expect(registry).toContain("ext === '.pdf'")
  })
})
