import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { HopprError } from '../core/errors.ts'
import { defaultPreset } from '../core/profiles.ts'
import { defaultProfile, defaultRawMode, describeSource, parseSource } from '../core/source.ts'
import { writeIfChanged } from './atomic.ts'
import { Layout } from './layout.ts'
import { readManifest, register } from './manifest.ts'

export interface HopperInfo {
  name: string
  root: string
  source: string
  sourceLabel: string
  profile: string
  rawMode: string
  description: string
}

/**
 * The registry is just the filesystem.
 *
 * Every directory under ~/.hoppr containing a hoppr.toml is a hoppr. No
 * central index file to corrupt, drift, or migrate — deleting the directory
 * deletes the hoppr, and copying one to another machine works.
 */
export async function listHoppers(): Promise<HopperInfo[]> {
  const out: HopperInfo[] = []
  const seen = new Set<string>()

  // The manifest first, because it is the only way to see a store that lives
  // outside ~/.hoppr. Then the directory scan, which keeps stores created
  // before the manifest existed visible with no migration step.
  for (const entry of await readManifest()) {
    if (seen.has(entry.path)) continue
    seen.add(entry.path)
    out.push(await readHopper(entry.name, entry.path))
  }
  for (const name of Layout.list()) {
    const root = join(Layout.home(), name)
    if (seen.has(root)) continue
    seen.add(root)
    out.push(await readHopper(name, root))
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

async function readHopper(name: string, root: string): Promise<HopperInfo> {
  let hopper: Record<string, unknown> = {}
  try {
    const parsed = parseToml(await readFile(join(root, 'hoppr.toml'), 'utf8')) as Record<
      string,
      unknown
    >
    hopper = (parsed.hopper ?? {}) as Record<string, unknown>
  } catch {
    /* a malformed config should not hide the hoppr from the list */
  }
  const source = String(hopper.source ?? 'manual')
  return {
    name,
    root,
    source,
    sourceLabel: safeDescribe(source),
    profile: String(hopper.profile ?? 'manual'),
    rawMode: String(hopper.raw_mode ?? 'copy'),
    description: String(hopper.description ?? ''),
  }
}

function safeDescribe(source: string): string {
  try {
    return describeSource(parseSource(source))
  } catch {
    return source
  }
}

export interface CreateOptions {
  name: string
  source: string
  description?: string
  rawMode?: 'reference' | 'copy'
  exclude?: string[]
  /** Curation preset: notes | papers | agents | index-only | minimal. */
  curation?: string
  /**
   * Where the store goes. Default: ~/.hoppr/<name>. Pass a directory to put it
   * there instead — `hoppr new x --here` passes `<cwd>/.hoppr`, which is the
   * git model: the store lives in the directory you made it in.
   */
  root?: string
}

/**
 * Write a hoppr's config. Deliberately minimal: everything else has a sane
 * default, and a config file you can read in ten seconds is worth more than
 * one that documents every knob.
 */
export async function createHopper(o: CreateOptions): Promise<HopperInfo> {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(o.name)) {
    throw HopprError.user(
      `'${o.name}' is not a usable hoppr name — use letters, numbers, dashes or dots.`,
    )
  }
  const root = o.root ? resolve(Layout.expand(o.root)) : join(Layout.home(), o.name)
  if (existsSync(join(root, 'hoppr.toml'))) {
    throw HopprError.user(`hoppr '${o.name}' already exists at ${root}`)
  }

  const spec = parseSource(o.source)
  if (spec.kind === 'dir' && !existsSync(spec.path ?? '')) {
    throw HopprError.user(`no such directory: ${spec.path}`)
  }

  const profile = defaultProfile(spec.kind)
  const rawMode = o.rawMode ?? defaultRawMode(spec.kind)
  const description = o.description ?? defaultDescription(o.name, spec.kind, spec)

  const body = `# hoppr: ${o.name}
#
# This store lives here; \`hoppr\` finds it by walking up from your working
# directory, and \`~/.hoppr/hoppers.json\` indexes it so the daemon and
# \`-H ${o.name}\` can reach it from anywhere.
${
  rawMode === 'reference'
    ? `# Raw inputs stay where they are — hoppr records provenance and extracted
# text, and never opens your files for writing.`
    : `# Durable captures are stored in raw/ because the upstream owner may
# change or remove the original. Agent sessions are normalized to Markdown.`
}

[hopper]
name = ${JSON.stringify(o.name)}
description = ${JSON.stringify(description)}
source = ${JSON.stringify(spec.raw)}
profile = ${JSON.stringify(profile)}
raw_mode = ${JSON.stringify(rawMode)}
# What to build from this source. \`hoppr curation\` lists the options.
curation = ${JSON.stringify(o.curation ?? defaultPreset(profile))}
${o.exclude?.length ? `exclude = ${JSON.stringify(o.exclude)}\n` : ''}
[git]
mode = "auto"

[curate]
deep_cron = "0 3 * * *"
`
  await writeIfChanged(join(root, 'hoppr.toml'), body)
  await register({ name: o.name, path: root, source: spec.raw })
  return readHopper(o.name, root)
}

/**
 * The one-line "when to use this" an agent reads to pick between hoppers.
 * Getting this right matters more than any tool schema — it IS the interface.
 */
function defaultDescription(
  name: string,
  kind: string,
  spec: ReturnType<typeof parseSource>,
): string {
  if (kind === 'dir') return `Documents and notes under ${spec.path}.`
  if (kind === 'agents') {
    return `Past AI coding sessions${
      spec.harnesses?.length ? ` from ${spec.harnesses.join(', ')}` : ''
    } — what was tried, what worked, and what broke.`
  }
  return `Notes and links captured by hand into '${name}'.`
}

export function hopperExists(name: string): boolean {
  return existsSync(join(Layout.home(), name, 'hoppr.toml'))
}
