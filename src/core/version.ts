import { createRequire } from 'node:module'

/**
 * The version, read from package.json rather than typed out.
 *
 * It was written by hand in five places and every one still said 0.0.1 after
 * the release was cut — so the published 0.1.0 introduced itself as 0.0.1 to
 * `--version`, to MCP clients in their handshake, and to anything polling
 * /healthz. A version string that disagrees with the registry is worse than no
 * version string: it sends someone debugging to the wrong source.
 */
const require = createRequire(import.meta.url)

function read(): string {
  // Bundled, the file sits one directory below dist/; from source it is two
  // above src/core/. Try both rather than assume a layout.
  for (const path of ['../package.json', '../../package.json']) {
    try {
      const pkg = require(path) as { version?: string }
      if (pkg.version) return pkg.version
    } catch {
      // Keep trying; a missing package.json is not fatal.
    }
  }
  return '0.0.0'
}

export const VERSION = read()
