/** Tiny output helpers. No dependency: a CLI that prints should not pull a tree. */
const CSI = '\u001b['
const RESET = '\u001b[0m'
const enabled = Boolean(
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb',
)
const wrap = (code: string) => (s: string) => (enabled ? `${CSI}${code}m${s}${RESET}` : s)

export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  cyan: wrap('36'),
}

/** Stable JSON envelope. Every read command supports --json so hooks never parse prose. */
export function envelope(data: unknown, meta: Record<string, unknown> = {}) {
  return { ok: true, data, meta }
}

export function printJson(data: unknown, meta: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify(envelope(data, meta), null, 2)}\n`)
}

export function human(bytes: number): string {
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return `${i === 0 ? n : n.toFixed(1)}${u[i]}`
}

/**
 * Accepts an ISO string or epoch millis: the store keeps `captured` as an INT
 * in SQLite and as an ISO string in the on-disk meta, and callers legitimately
 * hold either.
 */
export function relTime(at: string | number): string {
  const then = typeof at === 'number' ? at : Date.parse(at)
  if (Number.isNaN(then)) return String(at)
  const s = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
