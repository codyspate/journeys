import type { AircraftInfo } from './types'

export const TELEMETRY_FIELDS = [
  ['lat', 'PLANE LATITUDE', 'Degrees'],
  ['lon', 'PLANE LONGITUDE', 'Degrees'],
  ['altFt', 'PLANE ALTITUDE', 'Feet'],
  ['aglFt', 'PLANE ALT ABOVE GROUND', 'Feet'],
  ['headingTrue', 'PLANE HEADING DEGREES TRUE', 'Degrees'],
  ['pitch', 'PLANE PITCH DEGREES', 'Degrees'],
  ['bank', 'PLANE BANK DEGREES', 'Degrees'],
  ['iasKts', 'AIRSPEED INDICATED', 'Knots'],
  ['gsKts', 'GROUND VELOCITY', 'Knots'],
  ['vsFpm', 'VERTICAL SPEED', 'Feet per minute'],
  ['onGround', 'SIM ON GROUND', 'Bool'],
  ['engine1', 'GENERAL ENG COMBUSTION:1', 'Bool'],
  ['engine2', 'GENERAL ENG COMBUSTION:2', 'Bool'],
  ['engine3', 'GENERAL ENG COMBUSTION:3', 'Bool'],
  ['engine4', 'GENERAL ENG COMBUSTION:4', 'Bool'],
  ['fuelGal', 'FUEL TOTAL QUANTITY', 'Gallons'],
  ['gForce', 'G FORCE', 'GForce'],
  ['flaps', 'FLAPS HANDLE INDEX', 'Number'],
  ['gearDown', 'GEAR HANDLE POSITION', 'Bool'],
  ['parkingBrake', 'BRAKE PARKING POSITION', 'Bool'],
  ['stall', 'STALL WARNING', 'Bool'],
  ['overspeed', 'OVERSPEED WARNING', 'Bool'],
  ['windKts', 'AMBIENT WIND VELOCITY', 'Knots'],
  ['windDirTrue', 'AMBIENT WIND DIRECTION', 'Degrees'],
  ['simRate', 'SIMULATION RATE', 'Number'],
  ['touchdownFps', 'PLANE TOUCHDOWN NORMAL VELOCITY', 'Feet per second']
] as const

export type TelemetryKey = (typeof TELEMETRY_FIELDS)[number][0]
// While loading, or sitting in a menu, the sim parks the aircraft on the equator at longitude 0 or ±90
// (both seen in MSFS 2024). Nothing real is flown from those exact spots.
const PLACEHOLDER_LONGITUDES = [0, 90, -90, 180, -180]

/** False for the sim's placeholder positions and for missing numbers. */
export function isRealPosition(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false
  return Math.abs(lat) > 0.01 || !PLACEHOLDER_LONGITUDES.some((placeholder) => Math.abs(lon - placeholder) <= 0.01)
}

/** A longer silence than this between samples means the app or sim stalled; that time isn't counted. */
const MAX_SAMPLE_GAP_S = 30

/**
 * How much sim time passed between two telemetry samples: real seconds times the sim rate, and none
 * while the sim is paused. Flight times, fuel burn and time-to-go all need sim time, not wall-clock time.
 */
export function simSecondsBetween(previous: { t: number }, sample: { t: number; simRate?: number; pauseFlags?: number }): number {
  if (sample.pauseFlags) return 0
  const real = (sample.t - previous.t) / 1000
  if (!(real > 0) || real > MAX_SAMPLE_GAP_S) return 0
  const rate = sample.simRate && sample.simRate > 0 ? sample.simRate : 1
  return real * rate
}

/** Time in the air, in sim minutes. Older flights, logged before sim time was kept, fall back to the clock. */
export function airMinutes(flight: Pick<LogbookFlight, 'takeoffAt' | 'landedAt' | 'endedAt' | 'airSimSeconds'>): number | null {
  if (flight.takeoffAt === null) return null
  if (flight.airSimSeconds != null) return flight.airSimSeconds / 60
  const end = flight.landedAt ?? flight.endedAt
  return end ? (end - flight.takeoffAt) / 60000 : null
}

/** Block time, start to end, in sim minutes, with the same fallback for older flights. */
export function blockMinutes(flight: Pick<LogbookFlight, 'startedAt' | 'endedAt' | 'simSeconds'>): number | null {
  if (flight.simSeconds != null && flight.endedAt) return flight.simSeconds / 60
  return flight.endedAt ? (flight.endedAt - flight.startedAt) / 60000 : null
}

/** The sim's own pause flags (SimConnect Pause_EX1). 8 means the sim paused itself, as on its end-of-flight screen. */
export const SIM_PAUSED_ITSELF = 8

export type TelemetrySample = Record<TelemetryKey, number> & { t: number; pauseFlags?: number }

export type FlightStatus = 'in-progress' | 'complete' | 'ended-early' | 'interrupted'

/** Cut short: the sim or app stopped, or the player left mid-flight, before landing and parking. */
export const isUnfinished = (flight: { status: FlightStatus }) => flight.status === 'interrupted' || flight.status === 'ended-early'

export interface LandingRecord {
  t: number
  lat: number
  lon: number
  touchdownFpm: number | null
  maxG: number
  iasKts: number
  gsKts: number
  headwindKts: number
  crosswindKts: number
  bounces: number
}

export interface FlightEvent {
  t: number
  type: 'stall' | 'overspeed' | 'flaps' | 'gear'
  value: number
}

/** One recorded moment of a flight, trimmed to what the flight map draws. */
export interface TrackPoint {
  t: number
  /** Sim time since the flight started. Missing from tracks served by older versions. */
  simSeconds?: number
  lat: number
  lon: number
  altFt: number
  aglFt: number
  gsKts: number
  onGround: boolean
}

/** Everything flown, for the atlas: each flight's path, and the airports and countries visited. */
export interface Atlas {
  flights: AircraftFlight[]
  airports: { ident: string; name: string; country: string }[]
  /** ISO country codes, sorted. */
  countries: string[]
}

/** A screenshot attached to a flight, copied into Journeys' own folder. */
export interface FlightPhoto {
  id: string
  flightId: string
  takenAt: number
  /** Where the aircraft was when it was taken, if the flight was recording then. */
  lat: number | null
  lon: number | null
  /** Load it with this URL; the app serves it from its own folder. */
  url: string
}

/** The note and photo count for a flight, for showing alongside Journey legs and in lists. */
export interface FlightJournal {
  note: string
  photoCount: number
}

/** Where screenshots are picked up from, and whether that happens automatically. */
export interface PhotoSettings {
  autoAttach: boolean
  folders: string[]
}

/** One flight in an aircraft's history, with where it went and its recorded path. */
export interface AircraftFlight {
  flight: LogbookFlight
  /** Airports it left from and arrived at, when it was on one. */
  fromIdent: string | null
  toIdent: string | null
  track: TrackPoint[]
}

export interface LogbookFlight {
  id: string
  aircraft: AircraftInfo | null
  status: FlightStatus
  startedAt: number
  takeoffAt: number | null
  landedAt: number | null
  endedAt: number | null
  origin: { lat: number; lon: number }
  destination: { lat: number; lon: number } | null
  /** True if recording began with the aircraft already in the air. */
  startedAirborne: boolean
  distanceNm: number
  maxAltitudeFt: number
  maxG: number
  /** Sim time from start to end, which differs from the clock when the sim rate isn't 1x. Missing on older flights. */
  simSeconds?: number
  /** Sim time spent airborne. Missing on older flights. */
  airSimSeconds?: number
  fuelStartGal: number
  fuelEndGal: number
  landings: LandingRecord[]
  events: FlightEvent[]
}
