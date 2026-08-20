import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Packaged assets (default config, prompts, migrations) ship as real files
 * rather than inlined strings — prompts especially are meant to be read and
 * diffed by humans. Resolve against both the source tree and the bundled
 * dist/ layout so `node src/cli.ts` and `npx hoppr` behave identically.
 */
const ROOTS = [
  join(HERE, '..', '..', 'assets'), // src/core/  -> repo/assets
  join(HERE, '..', 'assets'), // dist/       -> repo/assets
  join(HERE, 'assets'),
]

export function assetDir(...parts: string[]): string {
  for (const r of ROOTS) {
    const p = join(r, ...parts)
    if (existsSync(p)) return p
  }
  throw new Error(`packaged asset missing: ${parts.join('/')}`)
}

export async function readAsset(...parts: string[]): Promise<string> {
  return readFile(assetDir(...parts), 'utf8')
}

export async function listAssets(dir: string): Promise<string[]> {
  return (await readdir(assetDir(dir))).sort()
}
