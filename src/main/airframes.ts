import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AirportIndex } from '../core/airports'
import type { AirframeStore } from '../core/airframes'
import { distanceNm } from '../core/recorder'
import { type AirframeRecord, type AirframeSave, airframeKey, DEFAULT_SETTINGS, type ParkedLocation, type Settings } from '../shared/airframe'
import type { Snapshot } from '../shared/types'

const PARKED_AT_AIRPORT_NM = 5
const SETTINGS_ID = 'settings'
const MIGRATIONS_ID = 'migrations'
/** Parking again this close to the last spot updates that history entry instead of adding one. */
const SAME_SPOT_NM = 0.03
const PARKED_HISTORY_LIMIT = 30

const position = (snapshot: Snapshot) => {
  const lat = snapshot.values['position.latitude']
  const lon = snapshot.values['position.longitude']
  return lat == null || lon == null ? null : { lat, lon }
}

export class AirframeDatabase implements AirframeStore {
  private readonly db: DatabaseSync
  private cachedSettings: Settings

  constructor(
    path: string,
    private readonly airports: AirportIndex
  ) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS airframes (key TEXT PRIMARY KEY, updated_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS airframe_saves (
        id TEXT PRIMARY KEY, key TEXT NOT NULL, kind TEXT NOT NULL, saved_at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS airframe_saves_by_key ON airframe_saves (key, saved_at);
    `)
    this.cachedSettings = { ...DEFAULT_SETTINGS, ...this.readSetting<Partial<Settings>>(SETTINGS_ID) }
  }

  private readSetting<T>(id: string): T | null {
    const row = this.db.prepare('SELECT data FROM settings WHERE id = ?').get(id)
    return row ? (JSON.parse(String(row.data)) as T) : null
  }

  private writeSetting(id: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(id, JSON.stringify(value))
  }

  get settings(): Settings {
    return this.cachedSettings
  }

  updateSettings(changes: Partial<Settings>): Settings {
    this.cachedSettings = { ...this.cachedSettings, ...changes }
    this.writeSetting(SETTINGS_ID, this.cachedSettings)
    return this.cachedSettings
  }

  get(key: string): AirframeRecord | null {
    const row = this.db.prepare('SELECT data FROM airframes WHERE key = ?').get(key)
    return row ? (JSON.parse(String(row.data)) as AirframeRecord) : null
  }

  /** The automatic save while parked. It also keeps one history entry per place the aircraft was parked. */
  save(key: string, snapshot: Snapshot): void {
    const location = this.locate(snapshot)
    this.write({ key, snapshot, location, nickname: this.get(key)?.nickname })

    const last = this.history(key).find((entry) => entry.kind === 'parked')
    const here = position(snapshot)
    const there = last && position(last.snapshot)
    const sameSpot = here && there && distanceNm(here.lat, here.lon, there.lat, there.lon) <= SAME_SPOT_NM
    if (last && sameSpot) {
      this.writeSave({ ...last, snapshot, location })
    } else {
      const name = location ? `Parked at ${location.ident}` : 'Parked away from an airport'
      this.writeSave({ id: randomUUID(), key, name, kind: 'parked', snapshot, location })
      this.trimParked(key)
    }
  }

  /** A save the player asked for. It becomes the aircraft's current save too. */
  saveManual(key: string, snapshot: Snapshot, name: string): AirframeSave {
    const location = this.locate(snapshot)
    this.write({ key, snapshot, location, nickname: this.get(key)?.nickname })
    const fallback = location ? `Saved at ${location.ident}` : 'Saved'
    const entry: AirframeSave = { id: randomUUID(), key, name: name.trim() || fallback, kind: 'manual', snapshot, location }
    this.writeSave(entry)
    return entry
  }

  /** A blank nickname goes back to the aircraft's own name. */
  rename(key: string, nickname: string): AirframeRecord {
    const record = this.get(key)
    if (!record) throw new Error('That aircraft is no longer saved.')
    const renamed = { ...record, nickname: nickname.trim() || undefined }
    this.write(renamed)
    return renamed
  }

  /** Forgets the aircraft and its whole history. */
  delete(key: string): void {
    this.db.prepare('DELETE FROM airframes WHERE key = ?').run(key)
    this.db.prepare('DELETE FROM airframe_saves WHERE key = ?').run(key)
  }

  list(): AirframeRecord[] {
    return this.db
      .prepare('SELECT data FROM airframes ORDER BY updated_at DESC')
      .all()
      .map((row) => JSON.parse(String(row.data)) as AirframeRecord)
  }

  history(key: string): AirframeSave[] {
    return this.db
      .prepare('SELECT data FROM airframe_saves WHERE key = ? ORDER BY saved_at DESC')
      .all(key)
      .map((row) => JSON.parse(String(row.data)) as AirframeSave)
  }

  getSave(id: string): AirframeSave {
    const row = this.db.prepare('SELECT data FROM airframe_saves WHERE id = ?').get(id)
    if (!row) throw new Error('That save no longer exists.')
    return JSON.parse(String(row.data)) as AirframeSave
  }

  /** A blank name keeps the old one. */
  renameSave(id: string, name: string): AirframeSave {
    const entry = this.getSave(id)
    const renamed = { ...entry, name: name.trim() || entry.name }
    this.writeSave(renamed)
    return renamed
  }

  deleteSave(id: string): void {
    this.getSave(id)
    this.db.prepare('DELETE FROM airframe_saves WHERE id = ?').run(id)
  }

  /**
   * Brings in saves from the old Restore lab once, as manual saves on the matching aircraft.
   * The lab's files are left where they are.
   */
  importLabSaves(snapshots: Snapshot[]): number {
    if (this.readSetting<{ labImported?: boolean }>(MIGRATIONS_ID)?.labImported) return 0
    let imported = 0
    for (const snapshot of [...snapshots].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))) {
      const key = airframeKey(snapshot.aircraft.title, snapshot.aircraft.livery)
      const exists = this.db.prepare('SELECT 1 FROM airframe_saves WHERE id = ?').get(snapshot.id)
      if (exists) continue
      const location = this.locate(snapshot)
      this.writeSave({ id: snapshot.id, key, name: snapshot.name, kind: 'manual', snapshot: { ...snapshot, id: key }, location })
      if (!this.get(key)) this.write({ key, snapshot: { ...snapshot, id: key }, location })
      imported++
    }
    this.writeSetting(MIGRATIONS_ID, { ...this.readSetting<object>(MIGRATIONS_ID), labImported: true })
    return imported
  }

  private write(record: AirframeRecord): void {
    this.db
      .prepare(
        `INSERT INTO airframes (key, updated_at, data) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data`
      )
      .run(record.key, record.snapshot.capturedAt, JSON.stringify(record))
  }

  private writeSave(entry: AirframeSave): void {
    this.db
      .prepare(
        `INSERT INTO airframe_saves (id, key, kind, saved_at, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET saved_at = excluded.saved_at, data = excluded.data`
      )
      .run(entry.id, entry.key, entry.kind, entry.snapshot.capturedAt, JSON.stringify(entry))
  }

  /** Manual saves stay until the player deletes them; old parking spots fall off the end. */
  private trimParked(key: string): void {
    this.db
      .prepare(
        `DELETE FROM airframe_saves WHERE key = ? AND kind = 'parked' AND id NOT IN (
           SELECT id FROM airframe_saves WHERE key = ? AND kind = 'parked' ORDER BY saved_at DESC LIMIT ?
         )`
      )
      .run(key, key, PARKED_HISTORY_LIMIT)
  }

  private locate(snapshot: Snapshot): ParkedLocation | null {
    const point = position(snapshot)
    if (!point) return null
    const airport = this.airports.nearest(point.lat, point.lon, PARKED_AT_AIRPORT_NM)
    return airport ? { ident: airport.ident, name: airport.name } : null
  }
}
