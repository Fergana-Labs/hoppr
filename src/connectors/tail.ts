import { open, stat } from 'node:fs/promises'
import type { TailCursor } from './types.ts'

export interface TailRead {
  lines: string[]
  cursor: TailCursor
  /** false ⇒ we stopped at a byte cap; call again for the rest. */
  done: boolean
}

const MAX_READ = 8 * 1024 * 1024

/**
 * Read new bytes from an append-only log.
 *
 * Two rules that look fussy and are not:
 *
 *  1. **Never advance past the last complete newline.** These files are being
 *     appended to *while we read*. A truncated final line is the normal case,
 *     not corruption — and an offset that swallows it loses that record
 *     permanently, because the next poll starts after it.
 *  2. **A shrunken file means the log was replaced**, not that we mis-counted.
 *     Reset to zero rather than reading from a stale offset into unrelated
 *     bytes.
 */
export async function tailLines(path: string, cursor?: TailCursor): Promise<TailRead> {
  const s = await stat(path)
  let offset = cursor?.offset ?? 0

  if (cursor && s.size < cursor.size) offset = 0
  if (offset >= s.size) {
    return {
      lines: [],
      cursor: { offset, size: s.size, mtimeMs: s.mtimeMs, emittedHash: cursor?.emittedHash },
      done: true,
    }
  }

  const want = Math.min(s.size - offset, MAX_READ)
  const buf = Buffer.allocUnsafe(want)
  const fh = await open(path, 'r')
  try {
    await fh.read(buf, 0, want, offset)
  } finally {
    await fh.close()
  }

  const lastNl = buf.lastIndexOf(0x0a)
  const complete = lastNl === -1 ? Buffer.alloc(0) : buf.subarray(0, lastNl + 1)
  const consumed = complete.byteLength

  return {
    lines: complete.toString('utf8').split('\n').filter(Boolean),
    cursor: {
      offset: offset + consumed,
      size: s.size,
      mtimeMs: s.mtimeMs,
      emittedHash: cursor?.emittedHash,
    },
    // If we hit the cap there is more to read; if we consumed nothing but the
    // file has grown, the tail is one partial line and we are caught up.
    done: consumed === 0 || offset + consumed >= s.size,
  }
}

/** Parse a JSONL line, tolerating the garbage a live file produces. */
export function parseLine<T = Record<string, unknown>>(line: string): T | undefined {
  const t = line.trim()
  if (t?.[0] !== '{') return undefined
  try {
    return JSON.parse(t) as T
  } catch {
    return undefined
  }
}
