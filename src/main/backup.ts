import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { BackupManifest } from '../shared/types'

const DATABASE = 'logbook.db'
const PHOTOS = 'photos'
const MANIFEST = 'journeys-backup.json'
const PENDING = 'restore-pending'
const BACKUP_VERSION = 1

export type { BackupManifest }

const stamp = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`
}

function count(db: DatabaseSync, table: string): number {
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0)
  } catch {
    return 0
  }
}

/**
 * Writes a complete copy of the player's data into a new, dated folder inside `destination`.
 * The database is copied with VACUUM INTO, so it's consistent even while the app is writing to it.
 */
export function writeBackup(userData: string, destination: string, now = new Date()): { folder: string; manifest: BackupManifest } {
  const folder = join(destination, `Journeys backup ${stamp(now)}`)
  if (existsSync(folder)) throw new Error('A backup from this minute is already there. Wait a minute, or choose another folder.')
  mkdirSync(folder, { recursive: true })

  const db = new DatabaseSync(join(userData, DATABASE))
  try {
    db.exec(`VACUUM INTO '${join(folder, DATABASE).replace(/'/g, "''")}'`)
    const manifest: BackupManifest = {
      app: 'Journeys',
      version: BACKUP_VERSION,
      createdAt: now.toISOString(),
      flights: count(db, 'flights'),
      journeys: count(db, 'journeys'),
      aircraft: count(db, 'airframes')
    }
    if (existsSync(join(userData, PHOTOS))) cpSync(join(userData, PHOTOS), join(folder, PHOTOS), { recursive: true })
    writeFileSync(join(folder, MANIFEST), JSON.stringify(manifest, null, 2))
    return { folder, manifest }
  } finally {
    db.close()
  }
}

const VERSION_FILE = 'version.json'
const AUTOMATIC_BACKUPS = 'backups'
const KEEP_AUTOMATIC = 5

/**
 * Run at startup. The first time a new version of Journeys starts, copies the player's data into
 * backups/ first, so an update that mishandled anything can be undone. Keeps the most recent few.
 * Returns the backup folder, or null if this isn't a new version (or there's nothing to back up yet).
 */
export function backupBeforeNewVersion(userData: string, version: string, now = new Date()): string | null {
  const marker = join(userData, VERSION_FILE)
  let previous: string | null = null
  try {
    previous = existsSync(marker) ? (JSON.parse(readFileSync(marker, 'utf8')) as { version?: string }).version ?? null : null
  } catch {
    previous = null
  }

  let folder: string | null = null
  if (previous && previous !== version && existsSync(join(userData, DATABASE))) {
    const destination = join(userData, AUTOMATIC_BACKUPS)
    mkdirSync(destination, { recursive: true })
    folder = writeBackup(userData, destination, now).folder
    const kept = readdirSync(destination)
      .filter((name) => name.startsWith('Journeys backup '))
      .sort()
      .reverse()
    for (const old of kept.slice(KEEP_AUTOMATIC)) rmSync(join(destination, old), { recursive: true, force: true })
  }
  writeFileSync(marker, JSON.stringify({ version }))
  return folder
}

/** Reads a backup folder's description, or explains why it isn't one. */
export function readBackup(folder: string): BackupManifest {
  const manifestPath = join(folder, MANIFEST)
  if (!existsSync(manifestPath) || !existsSync(join(folder, DATABASE))) {
    throw new Error("That folder isn't a Journeys backup. Choose the folder named “Journeys backup” followed by a date.")
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest
  if (manifest.app !== 'Journeys') throw new Error("That folder isn't a Journeys backup.")
  if (manifest.version > BACKUP_VERSION) throw new Error('That backup was made by a newer version of Journeys. Update Journeys first.')
  return manifest
}

/** Copies a backup next to the live data, to be swapped in the next time the app starts. */
export function stageRestore(userData: string, folder: string): BackupManifest {
  const manifest = readBackup(folder)
  const pending = join(userData, PENDING)
  rmSync(pending, { recursive: true, force: true })
  cpSync(folder, pending, { recursive: true })
  return manifest
}

/**
 * Run at startup, before anything opens the database. Moves the current data into a dated folder,
 * never deleting it, then puts the staged backup in its place. Returns where the old data went.
 */
export function applyPendingRestore(userData: string, now = new Date()): string | null {
  const pending = join(userData, PENDING)
  if (!existsSync(join(pending, DATABASE))) return null
  const setAside = join(userData, `before restore ${stamp(now)}`)
  mkdirSync(setAside, { recursive: true })
  for (const name of [DATABASE, `${DATABASE}-wal`, `${DATABASE}-shm`, PHOTOS]) {
    if (existsSync(join(userData, name))) renameSync(join(userData, name), join(setAside, name))
  }
  renameSync(join(pending, DATABASE), join(userData, DATABASE))
  if (existsSync(join(pending, PHOTOS))) renameSync(join(pending, PHOTOS), join(userData, PHOTOS))
  rmSync(pending, { recursive: true, force: true })
  return setAside
}
