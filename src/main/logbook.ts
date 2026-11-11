import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { type LogbookFlight, simSecondsBetween, type TelemetrySample, type TrackPoint } from '../shared/logbook'

const TRIVIAL_DISTANCE_NM = 0.5
const STOPPED_KTS = 1

const isTrivial = (flight: LogbookFlight) => flight.landings.length === 0 && flight.distanceNm < TRIVIAL_DISTANCE_NM

export class Logbook {
  private readonly db: DatabaseSync
  private readonly upsert: StatementSync
  private readonly insertSample: StatementSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS flights (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS samples (
        flight_id TEXT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
        t INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS samples_flight ON samples(flight_id, t);
      PRAGMA foreign_keys = ON;
    `)
    this.upsert = this.db.prepare(
      `INSERT INTO flights (id, started_at, status, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`
    )
    this.insertSample = this.db.prepare('INSERT INTO samples (flight_id, t, data) VALUES (?, ?, ?)')
    this.closeAbandonedFlights()
  }

  saveFlight(flight: LogbookFlight): void {
    this.upsert.run(flight.id, flight.startedAt, flight.status, JSON.stringify(flight))
  }

  addSample(flightId: string, sample: TelemetrySample): void {
    this.insertSample.run(flightId, sample.t, JSON.stringify(sample))
  }

  deleteFlight(id: string): void {
    this.db.prepare('DELETE FROM flights WHERE id = ?').run(id)
  }

  listFlights(limit = 200): LogbookFlight[] {
    const rows = this.db.prepare('SELECT data FROM flights ORDER BY started_at DESC LIMIT ?').all(limit)
    return rows.map((row) => JSON.parse(String(row.data)) as LogbookFlight)
  }

  /** The recorded path of a flight, thinned to at most `maxPoints` so long flights stay quick to draw. */
  track(flightId: string, maxPoints = 4000): TrackPoint[] {
    const rows = this.db.prepare('SELECT data FROM samples WHERE flight_id = ? ORDER BY t').all(flightId)
    const step = Math.max(1, Math.ceil(rows.length / maxPoints))
    const points: TrackPoint[] = []
    // Every sample counts towards sim time, even the ones thinned out of the drawn line.
    let previous: TelemetrySample | null = null
    let simSeconds = 0
    rows.forEach((row, i) => {
      const s = JSON.parse(String(row.data)) as TelemetrySample
      if (previous) simSeconds += simSecondsBetween(previous, s)
      previous = s
      // Always end where the flight ended.
      if (i % step !== 0 && i !== rows.length - 1) return
      points.push({ t: s.t, simSeconds, lat: s.lat, lon: s.lon, altFt: s.altFt, aglFt: s.aglFt, gsKts: s.gsKts, onGround: Boolean(s.onGround) })
    })
    return points
  }

  /** Every flight flown in one aircraft and livery, newest first. */
  flightsFor(title: string, livery: string, limit = 500): LogbookFlight[] {
    return this.listFlights(5000)
      .filter((flight) => flight.aircraft?.title === title && flight.aircraft.livery === livery)
      .slice(0, limit)
  }

  countSamples(flightId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM samples WHERE flight_id = ?').get(flightId)
    return Number(row?.count ?? 0)
  }

  close(): void {
    this.db.close()
  }

  /** Saves a flight cut short by a lost connection, unless nothing really happened. */
  saveInterrupted(flight: LogbookFlight): void {
    if (isTrivial(flight)) this.deleteFlight(flight.id)
    else this.saveFlight(flight)
  }

  /**
   * A flight still open at startup means the app or sim stopped before it was closed.
   * If it had landed and come to a stop, it was really finished; otherwise it was cut short.
   */
  private closeAbandonedFlights(): void {
    const rows = this.db.prepare("SELECT data FROM flights WHERE status != 'complete'").all()
    for (const row of rows) {
      const flight = JSON.parse(String(row.data)) as LogbookFlight
      if (flight.status !== 'in-progress') {
        this.saveInterrupted(flight)
        continue
      }
      const lastRow = this.db.prepare('SELECT data FROM samples WHERE flight_id = ? ORDER BY t DESC LIMIT 1').get(flight.id)
      const last = lastRow ? (JSON.parse(String(lastRow.data)) as TelemetrySample) : null
      const endedAt = last?.t ?? flight.startedAt
      const finished = last !== null && flight.landings.length > 0 && Boolean(last.onGround) && last.gsKts < STOPPED_KTS
      if (finished) {
        this.saveFlight({ ...flight, status: 'complete', endedAt, destination: { lat: last.lat, lon: last.lon } })
      } else {
        this.saveInterrupted({ ...flight, status: 'interrupted', endedAt })
      }
    }
  }
}
