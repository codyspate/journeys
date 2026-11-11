import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync } from 'node:zlib'
import { AirportIndex, airportsFromRows, type AirportRow } from '../core/airports'
import { applyFlight, createJourney, editRoute, reachOptions, reflow, updateSettings } from '../core/planner'
import { BurnMeter } from '../core/burn'
import { type Terrain, TerrainGrid } from '../core/terrain'
import type { DescentTarget } from '../core/descent'
import {
  type CreateJourneyInput,
  DEFAULT_DESCENT,
  type DescentSettings,
  type Journey,
  type JourneySettings,
  NO_LIMITS,
  type ReachOptions,
  type RouteEdit
} from '../shared/journey'
import type { LogbookFlight, TelemetrySample } from '../shared/logbook'

const REACH_INTERVAL_MS = 10_000

// Older Journeys have no avoid list or route limits.
const parseJourney = (data: unknown): Journey => {
  const journey = JSON.parse(String(data)) as Partial<Journey>
  return {
    ...journey,
    avoid: journey.avoid ?? [],
    limits: { ...NO_LIMITS, ...journey.limits },
    descent: { ...DEFAULT_DESCENT, ...journey.descent }
  } as Journey
}

function loadTerrain(path: string): Terrain | undefined {
  try {
    return TerrainGrid.fromBytes(gunzipSync(readFileSync(path)))
  } catch (e) {
    console.warn('Terrain data unavailable; planning without it.', e)
    return undefined
  }
}

export class JourneyService {
  readonly airports: AirportIndex
  readonly terrain: Terrain | undefined
  private readonly db: DatabaseSync
  private readonly burn = new BurnMeter()
  private lastReachAt = 0

  constructor(databasePath: string, airportsPath: string, terrainPath: string) {
    this.airports = new AirportIndex(airportsFromRows(JSON.parse(readFileSync(airportsPath, 'utf8')) as AirportRow[]))
    this.terrain = loadTerrain(terrainPath)
    mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new DatabaseSync(databasePath)
    this.db.exec(`
      PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS journeys (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL);
    `)
  }

  list(): Journey[] {
    return this.db
      .prepare('SELECT data FROM journeys ORDER BY created_at DESC')
      .all()
      .map((row) => parseJourney(row.data))
  }

  private get(id: string): Journey {
    const row = this.db.prepare('SELECT data FROM journeys WHERE id = ?').get(id)
    if (!row) throw new Error('That Journey no longer exists.')
    return parseJourney(row.data)
  }

  private save(journey: Journey): Journey {
    this.db
      .prepare(
        `INSERT INTO journeys (id, created_at, data) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`
      )
      .run(journey.id, journey.createdAt, JSON.stringify(journey))
    return journey
  }

  private current(): Journey | null {
    return this.list().filter((j) => j.status === 'active').sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0] ?? null
  }

  create(input: CreateJourneyInput): Journey {
    return this.save(createJourney(input, this.airports, randomUUID(), Date.now(), this.terrain))
  }

  /** Opening also refreshes the plan, so Journeys made before terrain data existed get it. */
  open(id: string): Journey {
    const journey = this.get(id)
    const refreshed = journey.status === 'active' ? reflow(journey, this.airports.all, this.terrain) : journey
    return this.save({ ...refreshed, lastOpenedAt: Date.now() })
  }

  updateSettings(id: string, settings: JourneySettings): Journey {
    return this.save(updateSettings(this.get(id), settings, this.airports.all, this.terrain))
  }

  edit(id: string, edit: RouteEdit): Journey {
    return this.save(editRoute(this.get(id), edit, this.airports, this.terrain))
  }

  /** A blank name goes back to the default "KSAN to KBOS" form. */
  rename(id: string, name: string): Journey {
    const journey = this.get(id)
    return this.save({ ...journey, name: name.trim() || `${journey.origin.ident} to ${journey.destination.ident}` })
  }

  /** Flights stay in the logbook; only the plan is removed. */
  delete(id: string): void {
    this.get(id)
    this.db.prepare('DELETE FROM journeys WHERE id = ?').run(id)
  }

  /** Attaches a finished flight to the current Journey if it departed from where the Journey left off. */
  recordFlight(flight: LogbookFlight): Journey | null {
    const journey = this.current()
    if (!journey) return null
    const updated = applyFlight(journey, flight, this.airports, this.terrain)
    return updated ? this.save(updated) : null
  }

  /** The next stop of the Journey being flown, for the top-of-descent pause. */
  descentTarget(): { target: DescentTarget; settings: DescentSettings; journeyId: string } | null {
    const journey = this.current()
    const next = journey?.legs.find((leg) => leg.status === 'planned')
    const airport = next && this.airports.get(next.to.ident)
    if (!journey || !airport) return null
    const { ident, name, lat, lon, elevationFt } = airport
    return { target: { ident, name, lat, lon, elevationFt }, settings: journey.descent, journeyId: journey.id }
  }

  /** Returns fresh reach options every few seconds while airborne. */
  reach(sample: TelemetrySample): ReachOptions | null {
    this.burn.add(sample)

    // Fuel and groundspeed are both in sim time, so the reach stays right at any sim rate.
    if (sample.onGround || sample.pauseFlags || sample.t - this.lastReachAt < REACH_INTERVAL_MS) return null
    this.lastReachAt = sample.t
    const journey = this.current()
    if (!journey) return null

    return reachOptions(
      journey,
      {
        lat: sample.lat,
        lon: sample.lon,
        fuelGal: sample.fuelGal,
        burnGph: this.burn.gallonsPerHour() ?? journey.performance.burnGph,
        gsKts: sample.gsKts
      },
      this.airports.all
    )
  }

  close(): void {
    this.db.close()
  }
}
