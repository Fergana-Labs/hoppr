import { existsSync, readdirSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { datePath } from '../core/ids.ts'
import { expandTilde, hopprHome, userHome } from './home.ts'
import { discoverUpward, manifestLookup } from './manifest.ts'

/**
 * EVERY path in the store derives from here. If a path is built by string
 * concatenation anywhere else, that is a bug.
 */
export class Layout {
  readonly root: string

  // No parameter properties: keeping the source erasable means `node src/cli.ts`
  // runs directly in strip-only mode, with no build step during development.
  constructor(root: string) {
    this.root = root
  }

  /** The user's home — the stop point for the upward walk. */
  static homeDir(): string {
    return userHome()
  }

  /** The default home for hoppers not created inside a project directory. */
  static home(): string {
    return hopprHome()
  }

  /**
   * Resolve which store a command acts on.
   *
   * A hoppr's store lives in the directory it was created in, the way a git
   * repo does — so this resolves the way git does: an explicit path wins, then
   * the environment, then an explicit name, then a `.hoppr/` found by walking
   * UP from the working directory, and only then the default.
   *
   * Independently of where the store sits, its raw inputs may live somewhere
   * else entirely: a folder hoppr points at ~/Downloads and leaves the files
   * there. Store location and source location are separate choices, and
   * conflating them is what makes "where does my data go" hard to answer.
   */
  static resolveRoot(explicit?: string, hopper?: string, cwd = process.cwd()): string {
    // Anything asked for EXPLICITLY — a path or a name, from a flag or from
    // code — outranks the ambient environment. HOPPR_STORE used to win over a
    // requested name, which meant the unpinned MCP server (whose launch entry
    // sets HOPPR_STORE) answered every `hopper: "x"` request from the default
    // store instead. Wrong-store reads with no error is the worst failure mode
    // this resolution has, so explicit beats ambient, always.
    if (explicit) return Layout.expand(explicit)
    if (hopper) return Layout.byName(hopper)

    if (process.env.HOPPR_STORE) return Layout.expand(process.env.HOPPR_STORE)
    if (process.env.HOPPR_HOPPER) return Layout.byName(process.env.HOPPR_HOPPER)

    const found = discoverUpward(cwd, Layout.homeDir())
    if (found) return found
    return join(Layout.home(), 'default')
  }

  /** A named hoppr: the manifest's location if it has one, else the default home. */
  static byName(name: string): string {
    const hit = manifestLookup(name)
    return hit ?? join(Layout.home(), name)
  }

  static expand(p: string): string {
    return expandTilde(p)
  }

  /** Daemon state is global — one process manages every hoppr. */
  static daemonFileGlobal(): string {
    return join(Layout.home(), 'daemon.json')
  }
  static daemonLogGlobal(): string {
    return join(Layout.home(), 'daemon.log')
  }

  /** Every hoppr under ~/.hoppr, by name. */
  static list(): string[] {
    const home = Layout.home()
    if (!existsSync(home)) return []
    return readdirSync(home, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .filter((e) => existsSync(join(home, e.name, 'hoppr.toml')))
      .map((e) => e.name)
      .sort()
  }

  /** The hoppr's own name, derived from its directory. */
  get name(): string {
    return basename(this.root)
  }

  // ── config & schema ──────────────────────────────────────────────
  get configFile() {
    return join(this.root, 'hoppr.toml')
  }
  /** The generated schema doc that makes the store self-describing. */
  get claudeMd() {
    return join(this.root, 'CLAUDE.md')
  }
  get gitignore() {
    return join(this.root, '.gitignore')
  }
  get inbox() {
    return join(this.root, 'inbox')
  }

  // ── TIER 1: raw ──────────────────────────────────────────────────
  get raw() {
    return join(this.root, 'raw')
  }
  get blobs() {
    return join(this.raw, 'blobs')
  }
  /** raw/2026/08/17 */
  rawDir(d: Date) {
    return join(this.raw, ...datePath(d).split('/'))
  }
  rawFile(d: Date, id: string, ext: string) {
    return join(this.rawDir(d), `${id}${ext}`)
  }
  rawMetaFile(d: Date, id: string) {
    return join(this.rawDir(d), `${id}.meta.json`)
  }

  // ── TIER 2: curated ──────────────────────────────────────────────
  get curated() {
    return join(this.root, 'curated')
  }
  get wiki() {
    return join(this.curated, 'wiki')
  }
  get wikiIndex() {
    return join(this.wiki, 'index.md')
  }
  get wikiLog() {
    return join(this.wiki, 'log.md')
  }
  get wikiOverview() {
    return join(this.wiki, 'overview.md')
  }
  pageDir(type: string) {
    // source -> sources/, concept -> concepts/, entity -> entities/ …
    return join(this.wiki, PAGE_DIRS[type] ?? `${type}s`)
  }
  pageFile(type: string, slug: string) {
    return join(this.pageDir(type), `${slug}.md`)
  }
  get tables() {
    return join(this.curated, 'tables')
  }
  tableDef(name: string) {
    return join(this.tables, `${name}.table.toml`)
  }
  tableRows(name: string) {
    return join(this.tables, `${name}.jsonl`)
  }
  get tagsFile() {
    return join(this.tables, 'tags.yaml')
  }
  get skills() {
    return join(this.curated, 'skills')
  }
  skillDir(slug: string) {
    return join(this.skills, slug)
  }
  skillFile(slug: string) {
    return join(this.skillDir(slug), 'SKILL.md')
  }
  skillMeta(slug: string) {
    return join(this.skillDir(slug), '.hoppr.json')
  }
  get prompts() {
    return join(this.curated, 'prompts')
  }
  promptFile(id: string) {
    return join(this.prompts, `${id}.md`)
  }
  get outputs() {
    return join(this.curated, 'outputs')
  }
  lintReport(day: string) {
    return join(this.outputs, `lint-${day}.md`)
  }

  // ── TIER 3: derived, gitignored ──────────────────────────────────
  get views() {
    return join(this.root, 'views')
  }
  get journal() {
    return join(this.root, 'journal')
  }
  get state() {
    return join(this.root, 'state')
  }
  get logs() {
    return join(this.state, 'logs')
  }
  get daemonFile() {
    return join(this.state, 'daemon.json')
  }
  get indexDir() {
    return join(this.root, '.index')
  }
  get dbFile() {
    return join(this.indexDir, 'hoppr.db')
  }
  get writeLock() {
    return join(this.indexDir, '.write.lock')
  }

  /** Store-relative POSIX path — the form written into frontmatter and the DB. */
  rel(abs: string): string {
    return relative(this.root, abs).split(sep).join('/')
  }
  abs(rel: string): string {
    return join(this.root, ...rel.split('/'))
  }
}

/** Explicit map: `entity` must become `entities`, not `entitys`. */
export const PAGE_DIRS: Record<string, string> = {
  source: 'sources',
  concept: 'concepts',
  entity: 'entities',
  comparison: 'comparisons',
  digest: 'digests',
}

/** Directories created by `hoppr init`. */
export function storeDirs(l: Layout, opts: { raw?: boolean } = {}): string[] {
  return [
    l.inbox,
    ...(opts.raw === false ? [] : [l.raw]),
    l.wiki,
    ...Object.values(PAGE_DIRS).map((d) => join(l.wiki, d)),
    l.tables,
    l.skills,
    l.prompts,
    l.outputs,
    l.views,
    l.journal,
    l.logs,
    l.indexDir,
  ]
}

/**
 * Only the two tracked tiers go into git. Everything here is rebuildable:
 * .index in seconds, views from curated/, inbox is transient, state is runtime.
 */
export const GITIGNORE = `# hoppr — rebuildable, do not track
.index/
views/
inbox/
state/

# Secrets. hoppr reads keys from here; they must never be committed, because
# removing a secret from a tracked file does not remove it from history.
.env
`
