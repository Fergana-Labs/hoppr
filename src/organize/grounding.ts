/**
 * Which commands a draft names that its evidence never ran.
 *
 * This used to be a hard gate: any unsupported command and the skill was
 * discarded. That was checking the wrong thing at the wrong level. A skill can
 * name only real commands and still be a complete misreading — the agent tried
 * a path, hit an error, worked around it, and wrote the first attempt up as the
 * procedure. Every command in it is real; the procedure is fiction.
 *
 * So this is now a *signal handed to the verifier* (`skill-verify`), which asks
 * the question that actually matters: does the evidence support what this says?
 * An unsupported command is strong evidence of invention, but it is evidence to
 * weigh — a transcript can be truncated, or record the command as prose rather
 * than a shell line — not a verdict to act on alone.
 */

/** Commands worth checking. Extending this list makes grounding STRICTER. */
const KNOWN_RUNNERS = [
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'git',
  'docker',
  'kubectl',
  'vitest',
  'jest',
  'pytest',
  'cargo',
  'go',
  'make',
  'psql',
  'sqlite3',
  'wrangler',
  'terraform',
  'gh',
  'aws',
  'gcloud',
  'poetry',
  'uv',
  'pip',
  'ruff',
  'eslint',
  'tsc',
  'python',
  'node',
  'deno',
]

/**
 * Subcommands that are wrappers, where the NEXT token is the real target.
 *
 * Without this `npm run build` and `npm run deploy:prod` both reduce to
 * "npm run", so a skill inventing a deploy script is grounded by any
 * transcript that ever ran a build. That is the single most common shape a
 * mined skill gets wrong, so it is the one worth resolving one token deeper.
 */
const WRAPPERS = new Set(['run', 'exec', 'x', 'dlx'])

const RUNNER = new RegExp(
  `\\b(${KNOWN_RUNNERS.join('|')})\\s+([a-zA-Z][\\w:.-]*)(?:\\s+([a-zA-Z][\\w:.\\/-]*))?`,
  'g',
)

/**
 * Every `runner subcommand` pair in a piece of text.
 *
 * Deliberately narrow. Grounding must never fire on prose — a false positive
 * discards a real skill, which is a worse outcome than letting one unusual
 * command through, since the alternative to a mined skill is no skill. So it
 * checks a closed list of runners with an explicit subcommand and ignores
 * everything else, including bare binaries and shell builtins.
 */
export function commandsIn(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(RUNNER)) {
    const [, runner, sub, target] = m
    const deep = WRAPPERS.has(sub!.toLowerCase()) && target
    out.add((deep ? `${runner} ${sub} ${target}` : `${runner} ${sub}`).toLowerCase())
  }
  return out
}

/**
 * Tool names are deliberately NOT checked, though MSCE checks them.
 *
 * Their verifier requires declared tools to come from a whitelist observed in
 * the traces, which works because a policy declares its tools in a structured
 * field. A SKILL.md names tools in prose — "read the config first", "grep for
 * the caller" — and matching those against observed tool calls fires on
 * ordinary English. A false positive here discards a real skill, and the
 * alternative to a mined skill is no skill, so the asymmetry says check only
 * what can be checked exactly.
 */

export interface GroundingResult {
  /** Commands the skill instructs that no supporting transcript ever ran. */
  invented: string[]
  /** How many of the skill's commands were observed in the evidence. */
  grounded: number
}

/**
 * Compare a draft's commands against the transcripts it claims to come from.
 *
 * `evidence` is the concatenated text of the supporting captures — the same
 * ones the miner was shown, resolved from the cluster rather than the model's
 * echo, so this cannot be satisfied by a citation the model invented.
 */
export function checkGrounding(body: string, evidence: string): GroundingResult {
  const claimed = commandsIn(body)
  // A skill with no commands is not suspicious — plenty of real procedures are
  // judgement rather than shell.
  if (claimed.size === 0) return { invented: [], grounded: 0 }
  const observed = commandsIn(evidence)
  const invented = [...claimed].filter((c) => !observed.has(c)).sort()
  return { invented, grounded: claimed.size - invented.length }
}
