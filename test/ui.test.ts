import { describe, expect, it } from 'vitest'
import { dashboardHtml } from '../src/http/ui.ts'

/**
 * The dashboard is one big string, so the compiler never sees its JavaScript.
 * A stray escape inside it is a syntax error that blanks EVERY tab, not just
 * the one that contains it — and nothing else in the suite would notice.
 */
function scripts(html: string): string {
  return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '').join('\n')
}

describe('dashboard page', () => {
  const html = dashboardHtml('test-token')

  it('emits JavaScript that actually parses', () => {
    // Caught a real break: '\n' inside the template literal became a literal
    // newline in the served page, terminating a string mid-expression.
    expect(() => new Function(scripts(html))).not.toThrow()
  })

  it('has no unescaped newline inside a single-quoted JS string', () => {
    for (const line of scripts(html).split('\n')) {
      const quotes = (line.match(/(?<!\\)'/g) ?? []).length
      expect(quotes % 2, `odd quote count in: ${line.trim().slice(0, 80)}`).toBe(0)
    }
  })

  it('exposes every tab the server has a route for', () => {
    for (const tab of ['Search', 'Wiki', 'Tables', 'Skills', 'Tags', 'Status', 'Daemon']) {
      expect(html).toContain(tab)
    }
  })

  it('carries the bearer token so the page can call the API', () => {
    expect(html).toContain('test-token')
  })
})
