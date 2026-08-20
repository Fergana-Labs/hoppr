import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaults } from '../src/config/schema.ts'
import { initStore } from '../src/store/init.ts'
import { Layout } from '../src/store/layout.ts'

export async function tempStore(): Promise<{ layout: Layout; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'hoppr-test-'))
  await initStore(root, defaults())
  return {
    layout: new Layout(root),
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}
