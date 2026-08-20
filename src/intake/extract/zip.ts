import { inflateRawSync } from 'node:zlib'

/**
 * A minimal ZIP reader, because every modern Office format is a ZIP of XML.
 *
 * Written by hand rather than pulled in: the alternative is a dependency per
 * format (mammoth, xlsx, …), each with its own release cadence and install
 * weight, to do something Node's own zlib already does. We only ever need
 * "give me these named entries", never writing, encryption, or ZIP64 spanning.
 *
 * Reads the central directory rather than scanning local headers, because a
 * local header may declare sizes of zero and defer them to a data descriptor —
 * a shape Word actually produces.
 */
export interface ZipEntry {
  name: string
  data: Buffer
}

const EOCD = 0x06054b50
const CEN = 0x02014b50

export function readZip(buf: Buffer, want?: (name: string) => boolean): ZipEntry[] {
  const eocd = findEocd(buf)
  if (eocd < 0) return []

  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out: ZipEntry[] = []

  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen

    if (want && !want(name)) continue
    if (localOff + 30 > buf.length) continue
    // The local header's own name/extra lengths are authoritative for the data
    // offset; the central directory's extra field is a different length.
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const start = localOff + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(start, start + compSize)
    try {
      out.push({ name, data: method === 0 ? Buffer.from(raw) : inflateRawSync(raw) })
    } catch {
      // One unreadable entry should not lose the rest of the document.
    }
  }
  return out
}

function findEocd(buf: Buffer): number {
  // The EOCD sits at the end, after a comment of up to 64KB.
  const from = Math.max(0, buf.length - 66_000)
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD) return i
  }
  return -1
}
