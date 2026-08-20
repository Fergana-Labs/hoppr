/**
 * Catch secrets we have no pattern for.
 *
 * The vendor patterns are precise and they name the key, which is what you need
 * in order to know what to rotate. What they cannot do is cover a vendor nobody
 * has written a pattern for yet — an internal service token, a new provider, a
 * password someone pasted.
 *
 * So: patterns first for the label, then this as the net underneath. It looks
 * for what a secret IS rather than which company issued it — a long run of
 * characters carrying far more information per character than language does.
 *
 * The whole cost is one pass and a 256-entry tally per candidate token, so it
 * runs on every capture without being noticeable.
 */

/** Shannon entropy in bits per character. */
export function shannon(s: string): number {
  if (!s) return 0
  const counts = new Map<string, number>()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

/**
 * Things that look random and are not secret.
 *
 * This list IS the feature. Entropy alone flags a git SHA, a UUID, a content
 * hash and a minified bundle — all of which are high-entropy by construction
 * and all of which are meant to be read. Redacting them would corrupt the text
 * while protecting nothing, and would train people to turn redaction off.
 */
const BENIGN: Array<{ name: string; re: RegExp }> = [
  { name: 'uuid', re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i },
  { name: 'git-sha', re: /^[0-9a-f]{7}$|^[0-9a-f]{40}$/i },
  { name: 'hash', re: /^(?:sha\d*[:-])?[0-9a-f]{32}$|^[0-9a-f]{64}$/i },
  { name: 'ulid', re: /^[0-9A-HJKMNP-TV-Z]{26}$/ },
  { name: 'integrity', re: /^sha(?:256|384|512)-/ },
  { name: 'hex-color', re: /^#?[0-9a-f]{6}$/i },
  { name: 'number', re: /^[\d.,_+-]+$/ },
  { name: 'path', re: /[/\\]/ },
  { name: 'version', re: /^v?\d+\.\d+/ },
  /**
   * Opaque IDs, which are high-entropy BY DESIGN and appear constantly in the
   * transcripts hoppr is pointed at. Found by running this over 10.7M
   * characters of real Claude Code logs: `srvtoolu_…` was the single largest
   * source of false positives, and redacting tool-call ids would make a
   * transcript unreadable while protecting nothing.
   */
  { name: 'tool-id', re: /^(?:toolu|srvtoolu|msg|req|run|call|evt|ch|thread)_[A-Za-z0-9]+$/ },
]

export interface EntropyOptions {
  /** Below this many characters, a random-looking token is usually not a key. */
  minLength?: number
  /** Bits per character. Base64 tops out near 6, hex near 4, English near 4.2. */
  minEntropy?: number
}

/**
 * Is this token secret-shaped?
 *
 * Requires length AND entropy AND mixed character classes. Each one alone has a
 * failure mode: length alone flags sentences, entropy alone flags hashes, and
 * character mixing alone flags ordinary identifiers like `parseHTTPResponse2`.
 */
export function looksSecret(token: string, o: EntropyOptions = {}): boolean {
  const minLength = o.minLength ?? 24
  const minEntropy = o.minEntropy ?? 3.7

  if (token.length < minLength || token.length > 512) return false
  if (BENIGN.some((b) => b.re.test(token))) return false
  // Only the alphabets keys are actually written in.
  if (!/^[A-Za-z0-9_\-+=./~]+$/.test(token)) return false

  const classes =
    Number(/[a-z]/.test(token)) +
    Number(/[A-Z]/.test(token)) +
    Number(/\d/.test(token)) +
    Number(/[_\-+=./~]/.test(token))
  if (classes < 3) return false

  // A long word from a natural language has low entropy; so does `aaaaaaaa…`.
  if (shannon(token) < minEntropy) return false

  // Real prose sometimes produces long hyphenated runs. A token that is mostly
  // pronounceable segments is a slug, not a secret.
  // Slugs. Real prose and real paths produce long hyphenated runs, and a
  // path-derived slug ("n-private-tmp-claude-501--Users-…") reads as random
  // without being secret. Digits are allowed in a segment because slugs carry
  // ids; what matters is that the SEGMENTS are short and word-shaped.
  const segments = token.split(/[-_.]/).filter(Boolean)
  if (
    segments.length >= 4 &&
    segments.every((seg) => seg.length <= 12 && /^[A-Za-z0-9]+$/.test(seg)) &&
    segments.filter((seg) => /^[A-Za-z]+$/.test(seg)).length >= segments.length / 2
  ) {
    return false
  }
  return true
}

/**
 * Redact high-entropy tokens, preferring the ones that look assigned.
 *
 * A bare high-entropy token in prose is more likely a hash than a secret, so
 * the threshold is raised unless something nearby says otherwise — an `=`, a
 * `:`, or a word like key/token/secret/password within a few characters.
 */
export function redactHighEntropy(
  text: string,
  o: EntropyOptions = {},
): { text: string; hits: number } {
  let hits = 0
  const out = text.replace(/[A-Za-z0-9_\-+=./~]{24,512}/g, (token, offset: number) => {
    const before = text.slice(Math.max(0, offset - 40), offset)
    const assigned =
      /(?:key|token|secret|password|passwd|pwd|auth|bearer|credential)\W{0,10}$/i.test(before)
    // Unassigned tokens must clear a higher bar: in running text, a long
    // random-looking string is usually an identifier someone needs to read.
    const opts = assigned ? o : { ...o, minEntropy: o.minEntropy ?? 4.2, minLength: 32 }
    if (!looksSecret(token, opts)) return token
    hits++
    return '«redacted:high-entropy»'
  })
  return { text: out, hits }
}
