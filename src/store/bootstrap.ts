import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from '../config/schema.ts'
import type { Db } from '../db/driver.ts'
import { stampBody } from '../organize/skills.ts'
import { writeIfChanged } from './atomic.ts'
import { buildPage } from './frontmatter.ts'
import { git, isRepo } from './git.ts'
import type { Layout } from './layout.ts'

/**
 * Skills a store can have on its first day, before it has mined anything.
 *
 * The cold-start problem is real and the usual answer to it is bad. Shipping a
 * pack of generally-good advice — verify your work, read before you write, do
 * not expand scope — produces files that are true, unobjectionable, and
 * useless, because an agent already behaves that way in the abstract and none
 * of it tells it anything about THIS place. Worse, it displaces attention:
 * every generic line loaded into a session is a line not spent on a specific
 * one, and a skill set that opens with platitudes teaches a reader that these
 * files are not worth reading.
 *
 * What makes a starter skill worth its tokens is specificity, and specificity
 * is detectable. "Verify by running" is a platitude; "verify by running
 * `npm run check` then `npm run test`, which is what this repo's CI runs" is a
 * procedure. The first is a hypothesis about people in general; the second is
 * a fact about a directory, and reading the directory is cheap.
 *
 * So the rule here is: **emit nothing that detection did not fill in.** A repo
 * with no test command gets no testing skill. That is the difference between
 * bootstrapping and padding.
 *
 * These are still hypotheses, not findings, and they say so in their own text.
 * They regenerate as the project changes, and stop regenerating the moment
 * someone edits one — after which it is that person's file.
 */
export interface ProjectProfile {
  dir: string
  repo: boolean
  /** node | python | go | rust — the ecosystems detection knows how to fill in. */
  stacks: string[]
  packageManager?: string
  /** Commands that prove a change works here, in the order to run them. */
  verify: string[]
  /** How to run one test rather than all of them, when that is knowable. */
  focusedTest?: string
  defaultBranch?: string
  /** 'conventional' when most recent subjects match `type(scope): …`. */
  commitStyle?: 'conventional' | 'plain'
  ci: boolean
  /** Top-level directories worth naming, so an agent stops guessing. */
  layout: Array<{ path: string; what: string }>
}

export async function detectProject(dir: string): Promise<ProjectProfile> {
  const p: ProjectProfile = {
    dir,
    repo: isRepo(dir),
    stacks: [],
    verify: [],
    ci: false,
    layout: [],
  }

  const pkgPath = join(dir, 'package.json')
  if (existsSync(pkgPath)) {
    p.stacks.push('node')
    const pkg = await readJson(pkgPath)
    const scripts = (pkg.scripts ?? {}) as Record<string, string>
    p.packageManager = existsSync(join(dir, 'pnpm-lock.yaml'))
      ? 'pnpm'
      : existsSync(join(dir, 'yarn.lock'))
        ? 'yarn'
        : existsSync(join(dir, 'bun.lockb'))
          ? 'bun'
          : 'npm'
    const run = (s: string) => `${p.packageManager} run ${s}`
    // Order matters and is not alphabetical: a type error makes a test failure
    // unreadable, so the cheap check goes first. This is the ordering the
    // repo's own CI almost always uses, and getting it backwards is a
    // recognizable way for a generated skill to look like it never ran.
    //
    // Aggregates are collapsed, and that is not a nicety. This repo's `check`
    // is `typecheck && lint && test`, so the naive list told an agent to run
    // all three twice — a generated skill whose first instruction wastes a
    // minute teaches its reader that these files are not worth following.
    const covered = subsumedScripts(scripts, VERIFY_SCRIPTS)
    for (const s of VERIFY_SCRIPTS) {
      if (scripts[s] && !covered.has(s)) p.verify.push(run(s))
    }
    if (scripts.test?.includes('vitest')) p.focusedTest = `${p.packageManager} run test -- <file>`
  }

  if (existsSync(join(dir, 'pyproject.toml')) || existsSync(join(dir, 'requirements.txt'))) {
    p.stacks.push('python')
    if (existsSync(join(dir, 'pyproject.toml'))) {
      const toml = await readFile(join(dir, 'pyproject.toml'), 'utf8').catch(() => '')
      if (/\bruff\b/.test(toml)) p.verify.push('ruff check .')
      if (/\bmypy\b/.test(toml)) p.verify.push('mypy .')
      if (/\bpytest\b/.test(toml)) {
        p.verify.push('pytest')
        p.focusedTest = 'pytest <path>::<test_name>'
      }
    }
  }

  if (existsSync(join(dir, 'go.mod'))) {
    p.stacks.push('go')
    p.verify.push('go build ./...', 'go test ./...')
    p.focusedTest = 'go test ./<pkg> -run <TestName>'
  }

  if (existsSync(join(dir, 'Cargo.toml'))) {
    p.stacks.push('rust')
    p.verify.push('cargo clippy -- -D warnings', 'cargo test')
    p.focusedTest = 'cargo test <test_name>'
  }

  p.ci = existsSync(join(dir, '.github', 'workflows')) || existsSync(join(dir, '.gitlab-ci.yml'))

  if (p.repo) {
    p.defaultBranch = await defaultBranch(dir)
    const subjects = (await git(dir, ['log', '--format=%s', '-n', '40']).catch(() => ''))
      .split('\n')
      .filter(Boolean)
    if (subjects.length >= 5) {
      const conventional = subjects.filter((s) => /^[a-z]+(\([^)]+\))?!?: /.test(s)).length
      p.commitStyle = conventional / subjects.length >= 0.6 ? 'conventional' : 'plain'
    }
  }

  p.layout = await describeLayout(dir)
  return p
}

/** Scripts that prove a change works, cheapest signal first. */
const VERIFY_SCRIPTS = ['check', 'typecheck', 'lint', 'build', 'test'] as const

const KNOWN_DIRS: Record<string, string> = {
  src: 'source',
  lib: 'source',
  app: 'source',
  test: 'tests',
  tests: 'tests',
  spec: 'tests',
  __tests__: 'tests',
  docs: 'documentation',
  doc: 'documentation',
  assets: 'packaged assets',
  scripts: 'scripts',
  migrations: 'schema migrations',
  examples: 'examples',
}

async function describeLayout(dir: string): Promise<Array<{ path: string; what: string }>> {
  const out: Array<{ path: string; what: string }> = []
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue
    const what = KNOWN_DIRS[e.name]
    if (what) out.push({ path: `${e.name}/`, what })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Scripts that another script already runs.
 *
 * A package script that shells out to `npm run lint` covers `lint`, so listing
 * both is asking for the same work twice.
 *
 * Only the scripts being considered for the verify list count as coverers.
 * Reading every script instead emptied the list on this very repo, because
 * `prepublishOnly` runs `check` and `build` — a script nobody would run to
 * check their work hid both of the ones you would.
 *
 * One level of nesting is resolved, which covers every real case seen — an
 * aggregate calls leaves, not other aggregates — and stops well short of
 * interpreting shell.
 */
export function subsumedScripts(
  scripts: Record<string, string>,
  coverers: readonly string[],
): Set<string> {
  const out = new Set<string>()
  for (const name of coverers) {
    const body = scripts[name]
    if (!body) continue
    for (const m of body.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([\w:-]+)/g)) {
      const called = m[1]
      // `npm run build` names a script; `npm install` and `npm ci` do not, and
      // `npm test` is the one bare form that does.
      if (!called || called === name) continue
      if (called in scripts) out.add(called)
    }
  }
  return out
}

/**
 * The repo's default branch, which is not the branch you happen to be on.
 *
 * `symbolic-ref HEAD` answers the second question, and using it here wrote a
 * starter skill telling a future agent that the default branch was whatever
 * feature branch existed the day `hoppr init` ran — wrong immediately, and
 * silently wrong forever after, in a file whose whole claim is that it was
 * read off the project rather than guessed.
 *
 * The remote's HEAD is the real answer where there is a remote. Without one,
 * the conventional names beat the current checkout, and no answer beats a
 * confident wrong one.
 */
async function defaultBranch(dir: string): Promise<string | undefined> {
  const remote = await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(
    () => '',
  )
  const named = remote.trim().replace(/^origin\//, '')
  if (named) return named
  for (const b of ['main', 'master']) {
    const ok = await git(dir, ['rev-parse', '--verify', '--quiet', b]).catch(() => '')
    if (ok.trim()) return b
  }
  return undefined
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

// ── the pack ────────────────────────────────────────────────────

interface Draft {
  slug: string
  description: string
  body: string
}

/**
 * Every starter skill this knows how to write, each returning null when
 * detection did not give it anything specific to say.
 *
 * Kept as a list of small functions rather than one big builder so that adding
 * a case — a Makefile, a monorepo, a Terraform root — is a local change and so
 * that each one carries its own "do I have enough to be useful" test next to
 * the text it would produce.
 */
const DRAFTS: Array<(p: ProjectProfile) => Draft | null> = [
  verifyBeforeDone,
  navigateThisRepo,
  commitHere,
]

function verifyBeforeDone(p: ProjectProfile): Draft | null {
  // No detected way to check anything means no skill. "Verify your work" with
  // no command attached is the platitude this whole module exists to avoid.
  if (p.verify.length === 0) return null
  const steps = p.verify.map((cmd, i) => `${i + 1}. \`${cmd}\``)
  return {
    slug: 'verify-before-done',
    description:
      'Use when you are about to report that a change works, is finished, or is ready ' +
      'to commit — before writing the summary, not after.',
    body: [
      '## The rule',
      '',
      'A change is done when it has been **run**, not when it has been written and the',
      'types check. Report what you ran and what it printed.',
      '',
      '## Procedure',
      '',
      // Scope matched to the change, not a fixed ritual.
      //
      // The first version of this listed every detected command and told the
      // agent to run all of them before reporting anything. That is the single
      // largest measured cause of skills making agents slower: Excessive
      // Verification is 67 of 182 efficiency regressions, and the whole
      // Excessive Procedure class is 114 — guidance that turns an optional
      // check into a mandatory one. A rule that costs a minute on a typo fix
      // is a rule people learn to skip, which also costs it the times it
      // mattered.
      'Match the check to the change:',
      '',
      `- **A typo, comment, or docs edit** — running proves nothing. Say what you changed.`,
      ...(p.focusedTest
        ? [`- **One function or one test** — \`${p.focusedTest}\`, and say what it printed.`]
        : []),
      `- **Anything that could break a neighbour** — the full sequence:`,
      '',
      ...steps,
      '',
      ...(p.ci
        ? [
            'That last sequence is what CI runs, so a green local run is the claim CI will make.',
            '',
          ]
        : []),
      'When you are unsure which case you are in, you are in the last one.',
      '',
      '## What goes wrong',
      '',
      '- Reporting "tests pass" without the count. `269 tests, all passing` is evidence;',
      '  `tests pass` is a claim that costs the reader a run to check.',
      '- Running only the test for the change when the change reached further than it.',
      '- Treating a clean typecheck as verification. It proves the shapes line up and',
      '  nothing at all about behaviour.',
      '',
      '## Do not use when',
      '',
      '- The task was to investigate or explain rather than to change anything.',
      '- The user asked for a draft, a sketch, or a work-in-progress — verification is',
      '  not what they are waiting on.',
      '',
      bootnote(),
    ].join('\n'),
  }
}

function navigateThisRepo(p: ProjectProfile): Draft | null {
  // Two directories is not a layout worth a file — an agent will find them.
  if (p.layout.length < 3) return null
  return {
    slug: 'where-things-live',
    description:
      'Use when you need to find or add a file in this project and do not already know ' +
      'where it belongs — before searching the whole tree.',
    body: [
      '## The rule',
      '',
      'Look in the directory that owns the thing before searching everywhere for it.',
      '',
      '## Procedure',
      '',
      '| Directory | Holds |',
      '|---|---|',
      ...p.layout.map((d) => `| \`${d.path}\` | ${d.what} |`),
      '',
      ...(p.stacks.length ? [`Stack: ${p.stacks.map((s) => `\`${s}\``).join(', ')}.`, ''] : []),
      '1. Narrow to the directory above that owns the concern.',
      '2. Search inside it before widening. A repo-wide grep for a common word',
      '   returns the vendored copy, the build output, and the fixture.',
      '3. A new file goes beside the closest existing one that does the same kind of',
      '   job, and matches its naming.',
      '',
      '## What goes wrong',
      '',
      '- Adding a file at the root because that is where the search landed.',
      '- Editing a build artifact that looks like source and having the change vanish.',
      '',
      '## Do not use when',
      '',
      '- You already know the file. This is for finding a home, not for re-deriving one.',
      '- The task names a path explicitly — that path wins over any convention here.',
      '',
      bootnote(),
    ].join('\n'),
  }
}

function commitHere(p: ProjectProfile): Draft | null {
  if (!p.repo || !p.commitStyle) return null
  const conventional = p.commitStyle === 'conventional'
  return {
    slug: 'commit-style-here',
    description:
      'Use when writing a commit message or a PR title in this repository — before ' +
      'composing the message, not after it is rejected.',
    body: [
      '## The rule',
      '',
      conventional
        ? 'Subjects follow Conventional Commits: `type(scope): summary`, lowercase type.'
        : 'Subjects are plain prose — no `type:` prefix. Match the surrounding history.',
      '',
      '## Procedure',
      '',
      '1. Read the last few subjects before writing one:',
      '   ```bash',
      '   git log --format=%s -n 10',
      '   ```',
      conventional
        ? '2. Use the same `type` values already in use. Do not invent a new one.'
        : '2. Write an imperative summary of what changed, not what you did.',
      `3. ${
        p.defaultBranch
          ? `The default branch here is \`${p.defaultBranch}\`. Branch before committing when you are on it.`
          : 'Branch before committing when you are on the default branch.'
      }`,
      '4. Commit or push only when asked.',
      '',
      '## What goes wrong',
      '',
      '- Inventing a commit type this repo has never used, which reads as foreign in',
      '  the log forever.',
      '- Describing the process ("updated some files") rather than the change.',
      '',
      '## Do not use when',
      '',
      '- Working in a different repository. This was read off this one, and its',
      '  history is the only thing that makes it true.',
      '',
      bootnote(),
    ].join('\n'),
  }
}

function bootnote(): string {
  return [
    '## Where this came from',
    '',
    'hoppr wrote this by **reading this project**, not by observing you — it is a',
    'hypothesis about how work is done here, filled in from what is on disk. It',
    'regenerates as the project changes, and stops the moment you edit it, after',
    'which it is yours. Skills mined from real sessions will accumulate alongside it.',
  ].join('\n')
}

export interface BootstrapResult {
  written: string[]
  /** Drafts that had nothing specific to say, and were correctly not written. */
  skipped: number
  profile: ProjectProfile
}

/**
 * Write the starter pack for a directory.
 *
 * Auto-accepted rather than proposed, on the same reasoning the ledgers use:
 * these are assembled by code from something checkable, they cite where they
 * came from, and making someone triage a file that says "run `npm test`" is
 * how a review queue stops being read. A mined procedure — a model's prose
 * about how work gets done — still gets the human gate.
 */
export async function bootstrapSkills(
  db: Db,
  l: Layout,
  cfg: Config,
  dir: string,
): Promise<BootstrapResult> {
  const profile = await detectProject(dir)
  const result: BootstrapResult = { written: [], skipped: 0, profile }
  if (!cfg.skills.enabled) return result

  const autoAccept = cfg.skills.approve !== 'review'
  for (const make of DRAFTS) {
    const d = make(profile)
    if (!d) {
      result.skipped++
      continue
    }

    // A hand-edited starter skill is that person's file now.
    //
    // Checked here rather than through `reconcileSkills`, and the row is left
    // with a NULL `path` so that scan skips it. That scan does two things:
    // pins the file, and records a reliability FAILURE against the skill.
    // The first is wanted; the second would be wrong. Editing a mined skill
    // means someone had to correct hoppr's reading of their sessions. Editing
    // a starter skill is the thing its own text asks for — it is a hypothesis
    // about the project, and replacing it with the truth is a success.
    const existing = db
      .prepare<{ state: string; body_hash: string }>(
        'SELECT state, body_hash FROM skills WHERE slug = :s',
      )
      .get({ s: d.slug })
    if (existing?.state === 'rejected') continue
    if (existing && (await handEdited(l, d.slug, existing.body_hash))) continue

    await writeIfChanged(
      l.skillFile(d.slug),
      buildPage({ name: d.slug, description: d.description }, d.body),
    )
    await writeIfChanged(
      l.skillMeta(d.slug),
      `${JSON.stringify(
        {
          slug: d.slug,
          managed_by: 'hoppr',
          kind: 'bootstrap',
          state: existing?.state ?? (autoAccept ? 'accepted' : 'proposed'),
          detected_from: profile.dir,
        },
        null,
        2,
      )}\n`,
    )
    const now = Date.now()
    db.prepare(
      `INSERT INTO skills(slug,name,description,path,state,kind,evidence_count,confidence,created,updated)
       VALUES (:slug,:slug,:desc,NULL,:state,'bootstrap',0,1,:now,:now)
       ON CONFLICT(slug) DO UPDATE SET description=:desc, updated=:now`,
    ).run({
      slug: d.slug,
      desc: d.description,
      state: existing?.state ?? (autoAccept ? 'accepted' : 'proposed'),
      now,
    })
    stampBody(db, d.slug, d.body)
    result.written.push(d.slug)
  }
  return result
}

async function handEdited(l: Layout, slug: string, bodyHash: string): Promise<boolean> {
  if (!bodyHash) return false
  const { parsePage } = await import('./frontmatter.ts')
  const text = await readFile(l.skillFile(slug), 'utf8').catch(() => '')
  if (!text) return false
  const { contentHash } = await import('../core/hash.ts')
  return contentHash(parsePage(text).body) !== bodyHash
}
