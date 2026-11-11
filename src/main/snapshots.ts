import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Snapshot } from '../shared/types'

/** Reads saves left by the old Restore lab, so they can be moved into each aircraft's history. */
export class SnapshotStore {
  constructor(private readonly directory: string) {}

  async list(): Promise<Snapshot[]> {
    await mkdir(this.directory, { recursive: true })
    const files = (await readdir(this.directory)).filter((file) => file.endsWith('.json'))
    const snapshots = await Promise.all(
      files.map(async (file) => JSON.parse(await readFile(join(this.directory, file), 'utf8')) as Snapshot)
    )
    return snapshots.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
  }
}
