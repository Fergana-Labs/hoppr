import type { z } from 'zod'
import { HopprError } from '../core/errors.ts'

/**
 * Strip markdown fences before parsing.
 *
 * This stays even when a provider supports structured output, because it
 * costs nothing and the alternative is a whole class of intermittent failures.
 * A model told "output only JSON" still returns ```json blocks — verified
 * against the Claude CLI while building this — and a preamble sentence before
 * the object is just as common.
 */
export function extractJson(raw: string): string {
  const text = raw.trim()

  const fenced = /```(?:json|jsonc)?\s*\n?([\s\S]*?)\n?```/.exec(text)
  if (fenced?.[1]) return fenced[1].trim()

  // No fence: find the outermost balanced object or array, so a leading
  // "Here is the JSON:" or a trailing note does not break the parse.
  const start = firstOf(text, ['{', '['])
  if (start === -1) return text
  const open = text[start]!
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') inString = !inString
    if (inString) continue
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return text.slice(start)
}

function firstOf(s: string, chars: string[]): number {
  let best = -1
  for (const c of chars) {
    const i = s.indexOf(c)
    if (i !== -1 && (best === -1 || i < best)) best = i
  }
  return best
}

export interface RepairContext {
  retry: (repairPrompt: string) => Promise<string>
}

/**
 * Parse, validate, and allow exactly ONE repair round-trip.
 *
 * One retry, not a loop: if a model cannot produce the shape after being shown
 * its own validation error, more attempts spend tokens without converging. The
 * second failure is TERMINAL for that row — which is what lets the caller
 * increment a failure counter and move on instead of wedging the whole batch.
 */
export async function parseJsonWithRepair<T>(
  raw: string,
  schema: z.ZodType<T>,
  ctx?: RepairContext,
): Promise<T> {
  const first = tryParse(raw, schema)
  if (first.ok) return first.value

  if (!ctx) throw HopprError.terminal(`model output failed validation: ${first.error}`)

  const repaired = await ctx.retry(
    `Your previous output failed validation.\n\nError:\n${first.error}\n\n` +
      `Previous output:\n${raw.slice(0, 4000)}\n\n` +
      'Return ONLY the corrected JSON. No prose, no code fence.',
  )
  const second = tryParse(repaired, schema)
  if (second.ok) return second.value

  throw HopprError.terminal(
    `model output failed validation after one repair attempt: ${second.error}`,
  )
}

type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: string }

function tryParse<T>(raw: string, schema: z.ZodType<T>): ParseOutcome<T> {
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJson(raw))
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${(e as Error).message}` }
  }
  const result = schema.safeParse(parsed)
  if (result.success) return { ok: true, value: result.data }
  return {
    ok: false,
    error: result.error.issues
      .slice(0, 6)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; '),
  }
}
