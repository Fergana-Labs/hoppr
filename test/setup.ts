import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Point HOME at a throwaway directory for the whole suite.
 *
 * `hoppr skills install` writes into `~/.claude/skills`, and once accepting a
 * skill also installed it, a single test run put three real skills into the
 * developer's own home directory. They loaded in the next agent session, which
 * is how it was noticed. `os.homedir()` reads `$HOME` on POSIX, so moving it
 * here makes that impossible for every test at once rather than asking each
 * one to remember.
 *
 * `HOPPR_HOME` too, so the manifest of registered hoppers is also disposable —
 * otherwise a test run edits `~/.hoppr/hoppers.json` and the daemon starts
 * watching temp directories that no longer exist.
 */
const sandbox = mkdtempSync(join(tmpdir(), 'hoppr-home-'))
process.env.HOME = sandbox
process.env.USERPROFILE = sandbox
process.env.HOPPR_HOME = join(sandbox, '.hoppr')
