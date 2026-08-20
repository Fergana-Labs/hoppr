import { describe, expect, it } from 'vitest'
import { looksSecret, redactHighEntropy, shannon } from '../src/intake/entropy.ts'
import { redact } from '../src/intake/redact.ts'

describe('entropy detection', () => {
  it('scores random strings above language', () => {
    expect(shannon('xj7Qp2mZvK9dLw3NrTf8')).toBeGreaterThan(shannon('the quick brown fox ju'))
  })

  it('catches a key from a vendor we have no pattern for', () => {
    // The entire point: patterns cover known vendors, entropy covers the rest.
    expect(redact('INTERNAL_TOKEN=xj7Qp2mZ_vK9dLw3NrTf8YbHs5Ea1CgUvB').redacted).toBe(true)
  })

  it('leaves the things that are random BY DESIGN', () => {
    const benign = [
      'commit 3f7a2b19c4e8d05f6a1b2c3d4e5f60718293a4b5 landed',
      'session 550e8400-e29b-41d4-a716-446655440000 started',
      '/Users/sam/code/hoppr/src/intake/redact-and-extract.ts',
      'parseHTTPResponseHeadersAndValidateChecksum',
      'The reciprocal rank fusion implementation uses k equals sixty',
    ]
    for (const t of benign) {
      expect(redactHighEntropy(t).hits, `flagged: ${t}`).toBe(0)
    }
  })

  it('leaves opaque ids alone', () => {
    // Found by running this over 10.7M characters of real Claude Code logs:
    // tool-call ids were the largest source of false positives, and redacting
    // them would make a transcript unreadable while protecting nothing.
    for (const id of ['srvtoolu_01WAC7ffCAnAtFs3cXYvswXG', 'toolu_01XXSK6myQbRs9VKTmsX8ErR']) {
      expect(looksSecret(id, { minEntropy: 4.2, minLength: 32 }), id).toBe(false)
      expect(redactHighEntropy(`tool ${id} ran`).hits, id).toBe(0)
    }
  })

  it('leaves a path-derived slug alone', () => {
    expect(redactHighEntropy('n-private-tmp-claude-501--Users-samzliu-code-67119').hits).toBe(0)
  })

  it('demands a higher bar when nothing nearby says "key"', () => {
    // A long random-looking token in running text is usually an identifier
    // someone needs to read; the same token after `token=` is not.
    const t = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tV9wX1yZ'
    expect(redactHighEntropy(`token=${t}`).hits).toBe(1)
  })

  it('labels a known vendor by vendor, not by shape', () => {
    // "«redacted:anthropic-key»" tells you what to rotate; "high-entropy" does not.
    const r = redact(`key sk-ant-api03-${'A'.repeat(40)} here`)
    expect(Object.keys(r.hits)).toContain('anthropic-key')
  })
})
