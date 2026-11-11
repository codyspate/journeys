import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyPendingRestore, backupBeforeNewVersion, readBackup, stageRestore, writeBackup } from './backup'

let root: string
let userData: string
let backups: string
const NOW = new Date(2026, 10, 10, 15, 30)

function flightsIn(dir: string): string[] {
  const db = new DatabaseSync(join(dir, 'logbook.db'))
  const ids = db.prepare('SELECT id FROM flights ORDER BY id').all().map((row) => String(row.id))
  db.close()
  return ids
}

function seed(dir: string, flightIds: string[], photo: string) {
  mkdirSync(join(dir, 'photos', 'f1'), { recursive: true })
  writeFileSync(join(dir, 'photos', 'f1', 'a.png'), photo)
  const db = new DatabaseSync(join(dir, 'logbook.db'))
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE flights (id TEXT PRIMARY KEY); CREATE TABLE journeys (id TEXT); CREATE TABLE airframes (key TEXT)')
  for (const id of flightIds) db.prepare('INSERT INTO flights VALUES (?)').run(id)
  db.close()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'journeys-backup-'))
  userData = join(root, 'userData')
  backups = join(root, 'Backups')
  mkdirSync(userData)
  mkdirSync(backups)
  seed(userData, ['f1', 'f2'], 'original photo')
})

describe('backing up', () => {
  it('writes a dated folder with the database, photos and a description', () => {
    const { folder, manifest } = writeBackup(userData, backups, NOW)
    expect(folder).toBe(join(backups, 'Journeys backup 2026-11-10 1530'))
    expect(manifest).toMatchObject({ app: 'Journeys', flights: 2, journeys: 0, aircraft: 0 })
    expect(flightsIn(folder)).toEqual(['f1', 'f2'])
    expect(readFileSync(join(folder, 'photos', 'f1', 'a.png'), 'utf8')).toBe('original photo')
    expect(readBackup(folder).flights).toBe(2)
  })

  it('will not overwrite a backup from the same minute', () => {
    writeBackup(userData, backups, NOW)
    expect(() => writeBackup(userData, backups, NOW)).toThrow('already there')
  })

  it('recognises a folder that is not a backup', () => {
    expect(() => readBackup(backups)).toThrow("isn't a Journeys backup")
  })
})

describe('restoring', () => {
  it('swaps the backup in at the next start, setting the current data aside', () => {
    const { folder } = writeBackup(userData, backups, NOW)
    // Things change after the backup was made.
    const db = new DatabaseSync(join(userData, 'logbook.db'))
    db.prepare('INSERT INTO flights VALUES (?)').run('f3')
    db.close()
    writeFileSync(join(userData, 'photos', 'f1', 'a.png'), 'newer photo')

    stageRestore(userData, folder)
    expect(flightsIn(userData)).toEqual(['f1', 'f2', 'f3'])

    const setAside = applyPendingRestore(userData, NOW)!
    expect(flightsIn(userData)).toEqual(['f1', 'f2'])
    expect(readFileSync(join(userData, 'photos', 'f1', 'a.png'), 'utf8')).toBe('original photo')
    expect(flightsIn(setAside)).toEqual(['f1', 'f2', 'f3'])
    expect(readFileSync(join(setAside, 'photos', 'f1', 'a.png'), 'utf8')).toBe('newer photo')
    expect(existsSync(join(userData, 'restore-pending'))).toBe(false)
  })

  it('does nothing at start when no restore is waiting', () => {
    expect(applyPendingRestore(userData, NOW)).toBeNull()
    expect(readdirSync(userData).sort()).toEqual(['logbook.db', 'photos'])
  })
})

describe('backing up before a new version', () => {
  const automatic = () => (existsSync(join(userData, 'backups')) ? readdirSync(join(userData, 'backups')).sort() : [])

  it('does nothing on the very first start, then remembers the version', () => {
    expect(backupBeforeNewVersion(userData, '0.1.0', NOW)).toBeNull()
    expect(backupBeforeNewVersion(userData, '0.1.0', NOW)).toBeNull()
    expect(automatic()).toEqual([])
  })

  it('backs up once when a new version starts', () => {
    backupBeforeNewVersion(userData, '0.1.0', NOW)
    const folder = backupBeforeNewVersion(userData, '0.2.0', NOW)!
    expect(flightsIn(folder)).toEqual(['f1', 'f2'])
    expect(backupBeforeNewVersion(userData, '0.2.0', new Date(2026, 10, 10, 16, 0))).toBeNull()
    expect(automatic()).toHaveLength(1)
  })

  it('keeps only the five most recent automatic backups', () => {
    backupBeforeNewVersion(userData, '0.1.0', NOW)
    for (let i = 1; i <= 7; i++) backupBeforeNewVersion(userData, `0.${i + 1}.0`, new Date(2026, 10, 10 + i, 12, 0))
    expect(automatic()).toHaveLength(5)
    expect(automatic()[0]).toBe('Journeys backup 2026-11-13 1200')
  })
})
