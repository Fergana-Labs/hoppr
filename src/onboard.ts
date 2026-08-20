import { createInterface } from 'node:readline/promises'
import { HARNESS_CONNECTORS } from './connectors/registry.ts'
import { c } from './core/out.ts'

export interface HarnessFinding {
  id: string
  label: string
  sources: number
}

/**
 * What agent history is already on this machine.
 *
 * Discovery is glob-and-stat only, so asking is cheap enough to do on every
 * `hoppr setup` rather than once at install. That matters because harnesses
 * get installed later, and a tool that only ever looked once would never
 * mention the one you started using last month.
 */
export async function findHarnesses(): Promise<HarnessFinding[]> {
  const out: HarnessFinding[] = []
  for (const conn of HARNESS_CONNECTORS) {
    if (!(await conn.detect({}).catch(() => false))) continue
    const sources = (await conn.discover({}).catch(() => [])).length
    if (sources > 0) out.push({ id: conn.id, label: conn.label ?? conn.id, sources })
  }
  return out
}

/**
 * Prompt, honestly, about cost.
 *
 * Nine thousand sessions is a real number on a real machine, and curating them
 * costs real money. The default window is 30 days for exactly this reason, and
 * saying so up front is the difference between a tool people trust and one
 * they uninstall after the first bill.
 */
export function describeFindings(found: HarnessFinding[]): string[] {
  return found.map(
    (f) =>
      `${c.bold(f.id.padEnd(14))} ${String(f.sources).padStart(6)} sessions  ${c.dim(f.label)}`,
  )
}

export interface AskOptions {
  /** Non-interactive: assume yes. */
  yes?: boolean
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}

/**
 * Ask a yes/no question, defaulting to NO on anything that is not a terminal.
 *
 * A piped or CI invocation must never silently create stores and start
 * spending tokens because nobody was there to say no.
 */
export async function confirm(question: string, o: AskOptions = {}): Promise<boolean> {
  if (o.yes) return true
  const input = o.input ?? process.stdin
  if (!(input as NodeJS.ReadStream).isTTY) return false
  const rl = createInterface({ input, output: o.output ?? process.stdout })
  try {
    const a = (await rl.question(`${question} ${c.dim('[y/N]')} `)).trim().toLowerCase()
    return a === 'y' || a === 'yes'
  } finally {
    rl.close()
  }
}
