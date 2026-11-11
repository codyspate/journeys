import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FlightJournal, FlightPhoto, LogbookFlight, PhotoSettings, TelemetrySample } from '../shared/logbook'

const IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i
/** Screenshots saved this long after a flight ends still belong to it. */
const AFTER_FLIGHT_MS = 2 * 60_000
/** A photo more than this far from any recorded moment gets no place on the map. */
const PLACE_WITHIN_MS = 5 * 60_000
const SETTINGS_ID = 'photos'

/** Where Windows and the Xbox Game Bar save screenshots, if they exist on this machine. */
export function defaultPhotoFolders(home = homedir()): string[] {
  return [join(home, 'Videos', 'Captures'), join(home, 'Pictures', 'Screenshots'), join(home, 'OneDrive', 'Pictures', 'Screenshots')].filter(
    (folder) => existsSync(folder)
  )
}

interface PhotoRow {
  id: string
  flight_id: string
  taken_at: number
  file: string
  lat: number | null
  lon: number | null
}

/** Notes and screenshots for each flight. Photos are copied in, so removing the originals loses nothing. */
export class FlightJournalStore {
  private readonly db: DatabaseSync

  constructor(
    databasePath: string,
    private readonly photoDir: string
  ) {
    this.db = new DatabaseSync(databasePath)
    this.db.exec(`
      PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS flight_notes (flight_id TEXT PRIMARY KEY, text TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS flight_photos (
        id TEXT PRIMARY KEY, flight_id TEXT NOT NULL, taken_at INTEGER NOT NULL, file TEXT NOT NULL,
        lat REAL, lon REAL, source TEXT
      );
      CREATE INDEX IF NOT EXISTS flight_photos_by_flight ON flight_photos (flight_id, taken_at);
      CREATE TABLE IF NOT EXISTS journal_settings (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    `)
  }

  get photoSettings(): PhotoSettings {
    const row = this.db.prepare('SELECT data FROM journal_settings WHERE id = ?').get(SETTINGS_ID)
    const saved = row ? (JSON.parse(String(row.data)) as Partial<PhotoSettings>) : {}
    return { autoAttach: saved.autoAttach ?? true, folders: saved.folders ?? defaultPhotoFolders() }
  }

  updatePhotoSettings(changes: Partial<PhotoSettings>): PhotoSettings {
    const next = { ...this.photoSettings, ...changes }
    this.db
      .prepare('INSERT INTO journal_settings (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(SETTINGS_ID, JSON.stringify(next))
    return next
  }

  note(flightId: string): string {
    const row = this.db.prepare('SELECT text FROM flight_notes WHERE flight_id = ?').get(flightId)
    return row ? String(row.text) : ''
  }

  setNote(flightId: string, text: string): string {
    const trimmed = text.trim()
    if (trimmed) {
      this.db
        .prepare(
          'INSERT INTO flight_notes (flight_id, text, updated_at) VALUES (?, ?, ?) ON CONFLICT(flight_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at'
        )
        .run(flightId, trimmed, Date.now())
    } else {
      this.db.prepare('DELETE FROM flight_notes WHERE flight_id = ?').run(flightId)
    }
    return trimmed
  }

  photos(flightId: string): FlightPhoto[] {
    return (this.db.prepare('SELECT * FROM flight_photos WHERE flight_id = ? ORDER BY taken_at').all(flightId) as unknown as PhotoRow[]).map(
      (row) => ({ id: row.id, flightId: row.flight_id, takenAt: row.taken_at, lat: row.lat, lon: row.lon, url: `journeys-photo://photo/${row.id}` })
    )
  }

  /** The file behind a photo id, for the app's own photo URLs. */
  photoFile(id: string): string | null {
    const row = this.db.prepare('SELECT flight_id, file FROM flight_photos WHERE id = ?').get(id)
    return row ? join(this.photoDir, String(row.flight_id), String(row.file)) : null
  }

  journals(flightIds: string[]): Record<string, FlightJournal> {
    const result: Record<string, FlightJournal> = {}
    for (const id of flightIds) {
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM flight_photos WHERE flight_id = ?').get(id)
      result[id] = { note: this.note(id), photoCount: Number(count?.n ?? 0) }
    }
    return result
  }

  /** Copies images in and places each on the flight's path by when it was taken. Returns what was added. */
  addPhotos(flightId: string, paths: string[]): FlightPhoto[] {
    const added: FlightPhoto[] = []
    const folder = join(this.photoDir, flightId)
    mkdirSync(folder, { recursive: true })
    for (const path of paths) {
      if (!IMAGE.test(path)) continue
      const already = this.db.prepare('SELECT 1 FROM flight_photos WHERE flight_id = ? AND source = ?').get(flightId, path)
      if (already) continue
      const takenAt = statSync(path).mtimeMs
      const id = randomUUID()
      const file = `${id}${extname(path).toLowerCase()}`
      copyFileSync(path, join(folder, file))
      const at = this.positionAt(flightId, takenAt)
      this.db
        .prepare('INSERT INTO flight_photos (id, flight_id, taken_at, file, lat, lon, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, flightId, Math.round(takenAt), file, at?.lat ?? null, at?.lon ?? null, path)
      added.push(...this.photos(flightId).filter((photo) => photo.id === id))
    }
    return added
  }

  /** Picks up screenshots saved while the flight was in progress, from the chosen folders. */
  attachScreenshotsFrom(flight: LogbookFlight): FlightPhoto[] {
    const settings = this.photoSettings
    if (!settings.autoAttach || !flight.endedAt) return []
    const from = flight.startedAt
    const to = flight.endedAt + AFTER_FLIGHT_MS
    const found: string[] = []
    for (const folder of settings.folders) {
      if (!existsSync(folder)) continue
      for (const name of readdirSync(folder)) {
        if (!IMAGE.test(name)) continue
        const path = join(folder, name)
        const time = statSync(path).mtimeMs
        if (time >= from && time <= to) found.push(path)
      }
    }
    return this.addPhotos(flight.id, found)
  }

  deletePhoto(id: string): void {
    const file = this.photoFile(id)
    this.db.prepare('DELETE FROM flight_photos WHERE id = ?').run(id)
    if (file) rmSync(file, { force: true })
  }

  /** Removes everything kept for a flight that left the logbook. */
  forgetFlight(flightId: string): void {
    this.db.prepare('DELETE FROM flight_notes WHERE flight_id = ?').run(flightId)
    this.db.prepare('DELETE FROM flight_photos WHERE flight_id = ?').run(flightId)
    rmSync(join(this.photoDir, flightId), { recursive: true, force: true })
  }

  private positionAt(flightId: string, t: number): { lat: number; lon: number } | null {
    const row = this.db.prepare('SELECT t, data FROM samples WHERE flight_id = ? ORDER BY ABS(t - ?) LIMIT 1').get(flightId, t)
    if (!row || Math.abs(Number(row.t) - t) > PLACE_WITHIN_MS) return null
    const sample = JSON.parse(String(row.data)) as TelemetrySample
    return { lat: sample.lat, lon: sample.lon }
  }

  close(): void {
    this.db.close()
  }
}
