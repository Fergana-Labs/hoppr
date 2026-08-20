import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Home resolution lives on its own so `layout` and `manifest` can both use it
 * without importing each other — resolving a store needs the manifest, and
 * finding the manifest needs a home, which is a cycle if either owns it.
 */
export function userHome(): string {
  return homedir()
}

/** The default home for hoppers not created inside a project directory. */
export function hopprHome(): string {
  const h = process.env.HOPPR_HOME ?? join(userHome(), '.hoppr')
  return expandTilde(h)
}

export function expandTilde(p: string): string {
  return p.startsWith('~') ? join(userHome(), p.slice(1)) : p
}
