import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { VERSION } from '../core/version.ts'
import { defaultTargets } from './install.ts'

export interface McpEntry {
  target: string
  present: boolean
  managedByHoppr: boolean
  pinnedTo?: string
  command?: string
}

/**
 * Which client configs actually reference hoppr.
 *
 * "Is the daemon up" and "can my agent reach hoppr" are different questions
 * with different answers: the MCP server is spawned by the client and needs no
 * daemon at all, so a healthy daemon tells you nothing about whether an agent
 * is wired up. This answers the second question.
 */
export async function mcpStatus(cwd = process.cwd()): Promise<McpEntry[]> {
  const targets = [...defaultTargets('project', cwd), ...defaultTargets('user')]
  const out: McpEntry[] = []
  for (const target of targets) {
    if (!existsSync(target)) {
      out.push({ target, present: false, managedByHoppr: false })
      continue
    }
    try {
      const cfg = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>
      const servers = (cfg.mcpServers ?? {}) as Record<
        string,
        { command?: string; args?: string[] }
      >
      const entry = servers.hoppr
      if (!entry) {
        out.push({ target, present: false, managedByHoppr: false })
        continue
      }
      const managed = Array.isArray(cfg.hopprManagedServers)
        ? (cfg.hopprManagedServers as string[]).includes('hoppr')
        : false
      const args = entry.args ?? []
      const at = args.indexOf('--hopper')
      out.push({
        target,
        present: true,
        managedByHoppr: managed,
        pinnedTo: args.includes('--pinned') && at >= 0 ? args[at + 1] : undefined,
        command: [entry.command, ...args].filter(Boolean).join(' '),
      })
    } catch {
      out.push({ target, present: false, managedByHoppr: false })
    }
  }
  return out
}

export interface HandshakeResult {
  ok: boolean
  tools: string[]
  error?: string
}

/**
 * Actually start the server and complete an MCP initialize handshake.
 *
 * Reading a config file only proves an entry exists. This proves the thing it
 * names can start and answer — which is the failure people actually hit, since
 * the entry is written once and the environment around it changes.
 */
export async function mcpHandshake(argv: string[], timeoutMs = 20_000): Promise<HandshakeResult> {
  return await new Promise<HandshakeResult>((resolve) => {
    const child = spawn(argv[0] ?? 'node', argv.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOPPR_MCP_PROBE: '1' },
    })
    let buf = ''
    let err = ''
    let done = false
    const finish = (r: HandshakeResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolve(r)
    }
    const timer = setTimeout(
      () => finish({ ok: false, tools: [], error: `no response in ${timeoutMs}ms` }),
      timeoutMs,
    )

    child.on('error', (e) => finish({ ok: false, tools: [], error: e.message }))
    // A server that exits before answering is the common failure — a store
    // that does not exist, a bad flag. Report its reason rather than making
    // the caller wait out the timeout for a silent process.
    child.on('close', (code) =>
      finish({
        ok: false,
        tools: [],
        error: `server exited ${code} before answering: ${(err.trim() || 'no stderr').slice(0, 200)}`,
      }),
    )
    child.stderr.on('data', (b: Buffer) => {
      err += b
    })
    child.stdout.on('data', (b: Buffer) => {
      buf += b
      // Framing is line-delimited JSON; one message per line.
      for (const line of buf.split('\n')) {
        const t = line.trim()
        if (!t.startsWith('{')) continue
        try {
          const msg = JSON.parse(t) as { id?: number; result?: { tools?: Array<{ name: string }> } }
          if (msg.id === 1) {
            child.stdin.write(
              `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
            )
          } else if (msg.id === 2) {
            finish({ ok: true, tools: (msg.result?.tools ?? []).map((x) => x.name) })
          }
        } catch {
          /* partial line; wait for more */
        }
      }
    })

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'hoppr-doctor', version: VERSION },
        },
      })}\n`,
    )
  })
}
