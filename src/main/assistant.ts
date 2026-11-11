import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import type { AirportIndex } from '../core/airports'
import { distanceNm, hasPosition } from '../core/recorder'
import type { AirframeRecord } from '../shared/airframe'
import type { Journey, Place } from '../shared/journey'
import type { FlightJournal, LogbookFlight, TelemetrySample } from '../shared/logbook'

/** Where the MCP server finds the running app. Readable only by this Windows user, like the rest of the app's data. */
export const ENDPOINT_FILE = 'mcp-endpoint.json'
const NEARBY_DEFAULT_NM = 30
const NEARBY_MAX_NM = 150
const NEARBY_LIMIT_DEFAULT = 10
const PLACEMARK_NM = 25

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
}

/** Read-only tools for AI assistants. Each returns plain facts from Journeys; none changes anything. */
export const TOOLS: ToolDefinition[] = [
  {
    name: 'get_current_flight',
    description:
      'Where the player is right now in Microsoft Flight Simulator: position, altitude, speed, heading, fuel, the nearest airport, ' +
      'the active Journey leg and how far it is to its next stop. Use this first for questions like "what am I flying over?".',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'find_airports_nearby',
    description: 'Airports near a point (by default, near the aircraft), nearest first, with runway length and elevation.',
    inputSchema: {
      type: 'object',
      properties: {
        lat: { type: 'number', description: 'Latitude in degrees. Defaults to the aircraft.' },
        lon: { type: 'number', description: 'Longitude in degrees. Defaults to the aircraft.' },
        radius_nm: { type: 'number', description: `Search radius in nautical miles, up to ${NEARBY_MAX_NM}. Default ${NEARBY_DEFAULT_NM}.` },
        limit: { type: 'number', description: `How many to return. Default ${NEARBY_LIMIT_DEFAULT}.` }
      }
    }
  },
  {
    name: 'get_journeys',
    description: "The player's multi-leg trips: each Journey's route, which legs are flown and which are planned, and the next leg.",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_logbook',
    description: 'Recent logged flights, newest first: aircraft, airports, times, distance, landing rate and the player’s notes.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'How many flights. Default 20, at most 200.' } } }
  },
  {
    name: 'get_flight',
    description: 'One logged flight in detail: landings, events such as stalls or overspeeds, the player’s note and photo count.',
    inputSchema: { type: 'object', properties: { flight_id: { type: 'string', description: 'An id from get_logbook.' } }, required: ['flight_id'] }
  },
  {
    name: 'get_hangar',
    description: "The player's aircraft and where each one is parked.",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_places',
    description: 'Airports the player pinned: their home field, places they have been, and places they want to go.',
    inputSchema: { type: 'object', properties: {} }
  }
]

export interface AssistantSources {
  connected: () => boolean
  lastSample: () => TelemetrySample | null
  aircraftName: () => string | null
  airports: AirportIndex
  journeys: () => Journey[]
  flights: (limit: number) => LogbookFlight[]
  journals: (ids: string[]) => Record<string, FlightJournal>
  airframes: () => AirframeRecord[]
  places: () => Place[]
}

const round = (value: number, places = 0) => Number(value.toFixed(places))

/** Compass bearing from one point to another, in whole degrees true. */
function bearing(from: { lat: number; lon: number }, to: { lat: number; lon: number }): number {
  const r = Math.PI / 180
  const y = Math.sin((to.lon - from.lon) * r) * Math.cos(to.lat * r)
  const x = Math.cos(from.lat * r) * Math.sin(to.lat * r) - Math.sin(from.lat * r) * Math.cos(to.lat * r) * Math.cos((to.lon - from.lon) * r)
  return Math.round(((Math.atan2(y, x) / r) + 360) % 360)
}

function nearby(sources: AssistantSources, lat: number, lon: number, radiusNm: number, limit: number) {
  return sources.airports.all
    .filter((a) => Math.abs(a.lat - lat) * 60 <= radiusNm)
    .map((a) => ({ airport: a, distance: distanceNm(lat, lon, a.lat, a.lon) }))
    .filter((entry) => entry.distance <= radiusNm)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map(({ airport, distance }) => ({
      ident: airport.ident,
      other_codes: airport.codes ?? [],
      name: airport.name,
      city: airport.city,
      country: airport.country,
      distance_nm: round(distance, 1),
      bearing_true: bearing({ lat, lon }, airport),
      elevation_ft: airport.elevationFt,
      longest_runway_ft: airport.runwayFt || null,
      paved: airport.runwayFt ? airport.hardSurface : null
    }))
}

const activeJourney = (journeys: Journey[]) =>
  journeys.filter((j) => j.status === 'active').sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0] ?? null

const airportName = (sources: AssistantSources, point: { lat: number; lon: number } | null) =>
  point ? (sources.airports.nearest(point.lat, point.lon, 3)?.ident ?? null) : null

function flightSummary(sources: AssistantSources, flight: LogbookFlight, journal?: FlightJournal) {
  const landing = flight.landings.at(-1)
  return {
    id: flight.id,
    aircraft: flight.aircraft ? `${flight.aircraft.title}${flight.aircraft.livery ? ` (${flight.aircraft.livery})` : ''}` : null,
    status: flight.status,
    started: new Date(flight.startedAt).toISOString(),
    from: flight.startedAirborne ? 'started in the air' : airportName(sources, flight.origin),
    to: flight.landings.length > 0 ? airportName(sources, flight.destination) : null,
    air_minutes: flight.takeoffAt && (flight.landedAt ?? flight.endedAt) ? round(((flight.landedAt ?? flight.endedAt)! - flight.takeoffAt) / 60000) : null,
    distance_nm: round(flight.distanceNm, 1),
    max_altitude_ft: round(flight.maxAltitudeFt),
    fuel_used_gal: round(flight.fuelStartGal - flight.fuelEndGal, 1),
    landings: flight.landings.length,
    last_touchdown_fpm: landing?.touchdownFpm != null ? round(landing.touchdownFpm) : null,
    note: journal?.note || null,
    photos: journal?.photoCount ?? 0
  }
}

/** Runs one tool. Throws with a plain message the AI can pass on. */
export function runTool(sources: AssistantSources, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'get_current_flight': {
      const sample = sources.lastSample()
      if (!sources.connected()) return { sim: 'not running', note: 'Microsoft Flight Simulator is not connected to Journeys right now.' }
      if (!sample || !hasPosition(sample)) return { sim: 'connected', note: 'No flight is loaded; the sim is in a menu or loading.' }
      const journey = activeJourney(sources.journeys())
      const next = journey?.legs.find((leg) => leg.status === 'planned') ?? null
      const closest = nearby(sources, sample.lat, sample.lon, PLACEMARK_NM, 1)[0] ?? null
      return {
        sim: sample.pauseFlags ? 'paused' : 'running',
        aircraft: sources.aircraftName(),
        position: { lat: round(sample.lat, 5), lon: round(sample.lon, 5) },
        on_ground: Boolean(sample.onGround),
        altitude_ft_msl: round(sample.altFt),
        height_above_ground_ft: round(sample.aglFt),
        groundspeed_kt: round(sample.gsKts),
        indicated_airspeed_kt: round(sample.iasKts),
        heading_true: round(sample.headingTrue),
        vertical_speed_fpm: round(sample.vsFpm),
        fuel_gal: round(sample.fuelGal, 1),
        wind: { from_true: round(sample.windDirTrue), speed_kt: round(sample.windKts) },
        nearest_airport: closest,
        journey: journey
          ? {
              name: journey.name,
              next_leg: next ? { from: next.from.ident, to: next.to.ident, to_name: next.to.name, planned_nm: round(next.distanceNm) } : null,
              to_next_stop_nm: next ? round(distanceNm(sample.lat, sample.lon, next.to.lat, next.to.lon), 1) : null,
              bearing_to_next_stop_true: next ? bearing(sample, next.to) : null
            }
          : null
      }
    }
    case 'find_airports_nearby': {
      const sample = sources.lastSample()
      const lat = typeof args.lat === 'number' ? args.lat : sample && hasPosition(sample) ? sample.lat : null
      const lon = typeof args.lon === 'number' ? args.lon : sample && hasPosition(sample) ? sample.lon : null
      if (lat === null || lon === null) throw new Error('No position given, and no flight is loaded to search around.')
      const radius = Math.min(NEARBY_MAX_NM, Math.max(1, Number(args.radius_nm) || NEARBY_DEFAULT_NM))
      const limit = Math.min(50, Math.max(1, Number(args.limit) || NEARBY_LIMIT_DEFAULT))
      return { around: { lat: round(lat, 4), lon: round(lon, 4) }, radius_nm: radius, airports: nearby(sources, lat, lon, radius, limit) }
    }
    case 'get_journeys':
      return sources.journeys().map((journey) => ({
        name: journey.name,
        status: journey.status,
        aircraft_profile: journey.performance.name,
        from: journey.origin.ident,
        to: journey.destination.ident,
        legs: journey.legs.map((leg) => ({
          from: leg.from.ident,
          to: leg.to.ident,
          to_name: leg.to.name,
          status: leg.status,
          distance_nm: round(leg.distanceNm),
          minutes: round(leg.minutes)
        }))
      }))
    case 'get_logbook': {
      const flights = sources.flights(Math.min(200, Math.max(1, Number(args.limit) || 20)))
      const journals = sources.journals(flights.map((f) => f.id))
      return flights.map((flight) => flightSummary(sources, flight, journals[flight.id]))
    }
    case 'get_flight': {
      const id = String(args.flight_id ?? '')
      const flight = sources.flights(5000).find((f) => f.id === id)
      if (!flight) throw new Error(`No logged flight has the id "${id}". Use get_logbook to find one.`)
      const journal = sources.journals([id])[id]
      return {
        ...flightSummary(sources, flight, journal),
        landings: flight.landings.map((l) => ({
          at: new Date(l.t).toISOString(),
          airport: airportName(sources, l),
          touchdown_fpm: l.touchdownFpm != null ? round(l.touchdownFpm) : null,
          g: round(l.maxG, 2),
          headwind_kt: round(l.headwindKts),
          crosswind_kt: round(l.crosswindKts),
          bounces: l.bounces
        })),
        events: flight.events.map((e) => ({ at: new Date(e.t).toISOString(), type: e.type, value: e.value }))
      }
    }
    case 'get_hangar':
      return sources.airframes().map((record) => ({
        aircraft: record.nickname ?? record.snapshot.aircraft.title,
        model: record.snapshot.aircraft.title,
        livery: record.snapshot.aircraft.livery,
        parked_at: record.location ? `${record.location.name} (${record.location.ident})` : 'away from an airport',
        last_saved: record.snapshot.capturedAt
      }))
    case 'get_places':
      return sources.places().map((place) => ({ ident: place.ident, name: place.name, city: place.city, kind: place.kind, note: place.note || null }))
    default:
      throw new Error(`Journeys has no tool called "${name}".`)
  }
}

/**
 * A localhost-only endpoint for the MCP server, guarded by a random token. It writes where to find it,
 * with the tool list, to a file in the app's data folder, and removes that file when it stops.
 */
export class AssistantEndpoint {
  private server: Server | null = null

  constructor(
    private readonly userData: string,
    private readonly sources: AssistantSources
  ) {}

  get running(): boolean {
    return this.server !== null
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve()
    const token = randomBytes(24).toString('hex')
    const server = createServer((request, response) => {
      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(body))
      }
      if (request.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'Not allowed.' })
      if (request.method !== 'POST' || request.url !== '/tool') return reply(404, { error: 'Not found.' })
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        try {
          const { name, args } = JSON.parse(body || '{}') as { name: string; args?: Record<string, unknown> }
          reply(200, { result: runTool(this.sources, name, args ?? {}) })
        } catch (error) {
          reply(200, { error: error instanceof Error ? error.message : String(error) })
        }
      })
    })
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : 0
        writeFileSync(join(this.userData, ENDPOINT_FILE), JSON.stringify({ url: `http://127.0.0.1:${port}/tool`, token, tools: TOOLS }, null, 2))
        this.server = server
        resolve()
      })
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null
    rmSync(join(this.userData, ENDPOINT_FILE), { force: true })
  }
}
