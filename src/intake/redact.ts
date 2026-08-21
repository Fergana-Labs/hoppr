import { redactHighEntropy } from './entropy.ts'

export interface RedactionRule {
  name: string
  re: RegExp
}

/**
 * Secret scrubbing.
 *
 * hoppr points at `~/.claude`, `~/.codex` and friends — logs full of pasted
 * credentials, echoed `.env` files, and `Authorization:` headers captured by a
 * Bash tool call. Without this it would index them, embed them, COMMIT THEM TO
 * GIT (where they survive deletion), and hand them to whichever model curates.
 * Verified against a real transcript on the machine this was built on.
 *
 * Three deliberate choices:
 *
 *  - It runs at the extraction boundary, so what a connector writes is already
 *    scrubbed. The upstream log is untouched — hoppr is not the system of
 *    record for your agent history and should not become a second copy of your
 *    secrets.
 *  - Replacements are labelled (`«redacted:anthropic-key»`) rather than blanked,
 *    so the surrounding text still reads and a human can see what was removed.
 *  - It is pattern-based and therefore incomplete by construction. This reduces
 *    exposure; it does not make an untrusted corpus safe to publish.
 */
export const DEFAULT_RULES: RedactionRule[] = [
  // Order matters: every `sk-…` key also matches the broad openai pattern, so
  // the specific vendors have to be tried first or the audit trail names the
  // wrong vendor — and "which key leaked" is the first question you ask.
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openrouter-key', re: /\bsk-or-v1-[a-f0-9]{48,}/g },
  { name: 'openai-key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g },
  { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { name: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'google-key', re: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'stripe-key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: 'hf-token', re: /\bhf_[A-Za-z0-9]{30,}/g },
  /**
   * A 1Password Secret Key, and it is not hypothetical: pointing hoppr at a
   * real ~/Downloads indexed an Emergency Kit PDF and put the key in a shadow
   * file in plaintext. Group-separated uppercase, so neither the vendor
   * patterns nor the entropy net saw it — the entropy rule treats short
   * alphanumeric segments as a slug, which is exactly this shape.
   */
  { name: 'onepassword-secret-key', re: /\bA3-[A-Z0-9]{6}(?:-[A-Z0-9]{5,6}){4,5}\b/g },
  /** Recovery codes: groups of hex or alphanumerics, printed to be kept. */
  { name: 'recovery-code', re: /\b(?:[a-z0-9]{4,5}-){3,7}[a-z0-9]{4,5}\b(?=[\s,;]|$)/gi },
  { name: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    name: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { name: 'bearer-token', re: /\b[Aa]uthorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'url-credentials', re: /\b([a-z][a-z0-9+.-]*):\/\/[^\s/:@]+:[^\s/@]+@/gi },
  // An assignment whose name says "secret" and whose value looks like one.
  {
    name: 'assigned-secret',
    re: /\b([A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[=:]\s*["']?([^\s"'`,;]{12,})["']?/g,
  },
]

export interface RedactResult {
  text: string
  /** Rule name → how many times it fired. Reported, never silent. */
  hits: Record<string, number>
  redacted: boolean
}

export function redact(
  input: string,
  opts: {
    enabled?: boolean
    extraPatterns?: string[]
    /**
     * The net under the patterns: catch secret-SHAPED tokens from vendors
     * nobody has written a pattern for. On by default; the patterns still run
     * first so a known key keeps its vendor label.
     */
    entropy?: boolean
  } = {},
): RedactResult {
  if (opts.enabled === false || !input) return { text: input, hits: {}, redacted: false }

  const rules = [...DEFAULT_RULES]
  for (const p of opts.extraPatterns ?? []) {
    try {
      rules.push({ name: 'custom', re: new RegExp(p, 'g') })
    } catch {
      // A bad user pattern must not break ingestion of everything else.
    }
  }

  const hits: Record<string, number> = {}
  let text = input
  for (const rule of rules) {
    text = text.replace(rule.re, (_match, ...groups) => {
      hits[rule.name] = (hits[rule.name] ?? 0) + 1
      // Keep the variable name and the scheme; drop only the secret itself.
      if (rule.name === 'assigned-secret') return `${groups[0]}=«redacted:secret»`
      if (rule.name === 'url-credentials') return `${groups[0]}://«redacted:credentials»@`
      if (rule.name === 'bearer-token') return 'Authorization: Bearer «redacted:token»'
      return `«redacted:${rule.name}»`
    })
  }
  // AFTER the patterns, so a known key is labelled by vendor rather than by
  // shape — "«redacted:anthropic-key»" tells you what to rotate, and
  // "«redacted:high-entropy»" only tells you something was there.
  if (opts.entropy !== false) {
    const e = redactHighEntropy(text)
    if (e.hits > 0) {
      text = e.text
      hits['high-entropy'] = (hits['high-entropy'] ?? 0) + e.hits
    }
  }

  return { text, hits, redacted: Object.keys(hits).length > 0 }
}

export function summarizeHits(hits: Record<string, number>): string {
  return Object.entries(hits)
    .map(([k, n]) => (n > 1 ? `${k}×${n}` : k))
    .join(', ')
}
