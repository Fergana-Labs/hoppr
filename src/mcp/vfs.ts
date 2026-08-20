import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join, normalize, relative, resolve, sep } from 'node:path'
import { glob } from 'tinyglobby'
import { HopprError } from '../core/errors.ts'
import type { Layout } from '../store/layout.ts'

/**
 * A read-only shell over the store.
 *
 * One tool instead of ten navigation tools. Every MCP tool costs context in
 * every conversation that loads the server, and `ls`/`cat`/`find`/`grep` are a
 * vocabulary agents already know — so a shell is both cheaper and more capable
 * than a bespoke tool per operation.
 *
 * Read-only by construction: there is no command that writes, and every path
 * is resolved against the store root and rejected if it escapes.
 */
export interface VfsResult {
  stdout: string
  exitCode: number
}

const MAX_OUTPUT = 60_000

export async function runVfs(l: Layout, script: string, cwd = '.'): Promise<VfsResult> {
  let out = ''
  let code = 0

  // Statement separators first, then pipes within each statement.
  for (const stmt of splitTop(script, [';', '&&'])) {
    if (!stmt.text.trim()) continue
    if (code !== 0 && stmt.op === '&&') break
    const piped = splitTop(stmt.text, ['|'])
    let stdin = ''
    for (const seg of piped) {
      const r = await runOne(l, seg.text.trim(), cwd, stdin)
      stdin = r.stdout
      code = r.exitCode
      if (code !== 0) break
    }
    out += stdin
    if (out.length > MAX_OUTPUT) {
      out = `${out.slice(0, MAX_OUTPUT)}\n… [output truncated]`
      break
    }
  }
  return { stdout: out, exitCode: code }
}

interface Segment {
  text: string
  op: string
}

function splitTop(input: string, ops: string[]): Segment[] {
  const out: Segment[] = []
  let buf = ''
  let prevOp = ''
  let quote: string | null = null
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (quote) {
      if (ch === quote) quote = null
      buf += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buf += ch
      continue
    }
    const two = input.slice(i, i + 2)
    const matched = ops.find((o) => (o.length === 2 ? two === o : ch === o))
    if (matched) {
      out.push({ text: buf, op: prevOp })
      prevOp = matched
      buf = ''
      if (matched.length === 2) i++
      continue
    }
    buf += ch
  }
  out.push({ text: buf, op: prevOp })
  return out
}

function tokenize(cmd: string): string[] {
  const out: string[] = []
  let buf = ''
  let quote: string | null = null
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null
      else buf += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (buf) out.push(buf)
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf) out.push(buf)
  return out
}

/** Resolve inside the store or refuse. This is the whole sandbox. */
function safePath(l: Layout, cwd: string, p: string): string {
  const abs = resolve(l.root, cwd, p)
  const rel = relative(l.root, abs)
  if (rel.startsWith('..') || (rel.startsWith(sep) && rel !== '')) {
    throw HopprError.user(`path escapes the store: ${p}`)
  }
  return abs
}

async function runOne(l: Layout, cmd: string, cwd: string, stdin: string): Promise<VfsResult> {
  const [name, ...args] = tokenize(cmd)
  if (!name) return { stdout: stdin, exitCode: 0 }
  const flags = args.filter((a) => a.startsWith('-'))
  const rest = args.filter((a) => !a.startsWith('-'))
  const has = (f: string) => flags.some((x) => x.includes(f.replace('-', '')))

  switch (name) {
    case 'ls': {
      const target = safePath(l, cwd, rest[0] ?? '.')
      if (!existsSync(target)) return err(`ls: ${rest[0] ?? '.'}: no such file or directory`)
      const s = await stat(target)
      if (s.isFile()) return { stdout: `${rest[0]}\n`, exitCode: 0 }
      const { readdir } = await import('node:fs/promises')
      const entries = (await readdir(target, { withFileTypes: true }))
        .filter((e) => has('a') || !e.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name))
      return {
        stdout: `${entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n')}\n`,
        exitCode: 0,
      }
    }
    case 'cat': {
      if (rest.length === 0) return { stdout: stdin, exitCode: 0 }
      let out = ''
      for (const p of rest) {
        const target = safePath(l, cwd, p)
        if (!existsSync(target)) return err(`cat: ${p}: no such file or directory`)
        out += await readFile(target, 'utf8')
      }
      return { stdout: out, exitCode: 0 }
    }
    case 'find': {
      const base = rest[0] ?? '.'
      const nameIdx = args.indexOf('-name')
      const pattern = nameIdx >= 0 ? args[nameIdx + 1] : undefined
      safePath(l, cwd, base)
      const hits = await glob([join(base, '**', pattern ?? '*')], { cwd: l.root, dot: false })
      return { stdout: `${hits.sort().join('\n')}\n`, exitCode: hits.length ? 0 : 1 }
    }
    case 'tree': {
      const base = rest[0] ?? '.'
      safePath(l, cwd, base)
      const hits = (await glob([join(base, '**/*')], { cwd: l.root })).sort()
      return { stdout: `${hits.slice(0, 500).join('\n')}\n`, exitCode: 0 }
    }
    case 'grep':
    case 'rg': {
      const pattern = rest[0]
      if (!pattern) return err('grep: no pattern')
      const targets = rest.slice(1)
      let re: RegExp
      try {
        re = new RegExp(pattern, has('i') ? 'i' : '')
      } catch {
        return err(`grep: invalid pattern: ${pattern}`)
      }
      const lines: string[] = []
      if (targets.length === 0) {
        for (const line of stdin.split('\n')) if (re.test(line) !== has('v')) lines.push(line)
      } else {
        const files: string[] = []
        for (const t of targets) {
          safePath(l, cwd, t)
          const s = existsSync(safePath(l, cwd, t)) ? await stat(safePath(l, cwd, t)) : undefined
          if (s?.isDirectory()) files.push(...(await glob([join(t, '**/*')], { cwd: l.root })))
          else files.push(normalize(join(cwd, t)))
        }
        for (const f of files.sort()) {
          const abs = safePath(l, '.', f)
          if (!existsSync(abs) || (await stat(abs)).isDirectory()) continue
          const text = await readFile(abs, 'utf8').catch(() => '')
          text.split('\n').forEach((line, i) => {
            if (re.test(line) !== has('v')) {
              lines.push(has('n') ? `${f}:${i + 1}:${line}` : `${f}:${line}`)
            }
          })
        }
      }
      return { stdout: lines.length ? `${lines.join('\n')}\n` : '', exitCode: lines.length ? 0 : 1 }
    }
    case 'head':
    case 'tail': {
      const nIdx = args.indexOf('-n')
      const n = nIdx >= 0 ? Number(args[nIdx + 1]) : 10
      // `-n 2` puts a bare "2" in rest; treating it as a filename silently
      // returns nothing, which reads as "no matches" rather than a mistake.
      const files = nIdx >= 0 ? rest.filter((x) => x !== args[nIdx + 1]) : rest
      const body = files.length
        ? await readFile(safePath(l, cwd, files[0]!), 'utf8').catch(() => '')
        : stdin
      const lines = body.split('\n')
      const picked = name === 'head' ? lines.slice(0, n) : lines.slice(-n)
      return { stdout: `${picked.join('\n')}\n`, exitCode: 0 }
    }
    case 'wc': {
      const body = rest.length ? await readFile(safePath(l, cwd, rest[0]!), 'utf8') : stdin
      const lines = body ? body.replace(/\n$/, '').split('\n').length : 0
      return has('l')
        ? { stdout: `${lines}\n`, exitCode: 0 }
        : {
            stdout: `${lines} ${body.split(/\s+/).filter(Boolean).length} ${body.length}\n`,
            exitCode: 0,
          }
    }
    case 'sort': {
      const lines = stdin.split('\n').filter(Boolean).sort()
      return { stdout: `${(has('r') ? lines.reverse() : lines).join('\n')}\n`, exitCode: 0 }
    }
    case 'uniq': {
      const lines = stdin.split('\n').filter(Boolean)
      const out: string[] = []
      const counts = new Map<string, number>()
      for (const l2 of lines) counts.set(l2, (counts.get(l2) ?? 0) + 1)
      if (has('c')) for (const [k, v] of counts) out.push(`${String(v).padStart(4)} ${k}`)
      else for (const k of counts.keys()) out.push(k)
      return { stdout: `${out.join('\n')}\n`, exitCode: 0 }
    }
    case 'echo':
      return { stdout: `${rest.join(' ')}\n`, exitCode: 0 }
    case 'pwd':
      return { stdout: `${cwd}\n`, exitCode: 0 }
    default:
      return err(
        `${name}: not available. This is a read-only shell: ls cat find tree grep head tail wc sort uniq echo pwd, with | ; &&`,
      )
  }
}

function err(msg: string): VfsResult {
  return { stdout: `${msg}\n`, exitCode: 1 }
}
