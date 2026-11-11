import type { AirframeRecord, LiveSim } from '../../shared/airframe'
import type { Journey, Leg, Stop } from '../../shared/journey'

const SAME_PLACE_NM = 3

function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180
  const a =
    Math.sin(((lat2 - lat1) * toRad) / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(((lon2 - lon1) * toRad) / 2) ** 2
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** Where an aircraft is parked, from its save. */
export function parkedAt(record: AirframeRecord): { lat: number; lon: number } | null {
  const lat = record.snapshot.values['position.latitude']
  const lon = record.snapshot.values['position.longitude']
  return lat == null || lon == null ? null : { lat, lon }
}

const isAt = (stop: Stop, point: { lat: number; lon: number } | null) =>
  point !== null && distanceNm(stop.lat, stop.lon, point.lat, point.lon) <= SAME_PLACE_NM

/** The Journey to put first: the active one opened most recently. */
export function currentJourney(journeys: Journey[]): Journey | null {
  return journeys.filter((j) => j.status === 'active').sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0] ?? null
}

export interface JourneyProgress {
  next: Leg | null
  legNumber: number
  legCount: number
  remainingNm: number
  remainingMinutes: number
}

export function progressOf(journey: Journey): JourneyProgress {
  const planned = journey.legs.filter((leg) => leg.status === 'planned')
  return {
    next: planned[0] ?? null,
    legNumber: journey.legs.length - planned.length + 1,
    legCount: journey.legs.length,
    remainingNm: planned.reduce((sum, leg) => sum + leg.distanceNm, 0),
    remainingMinutes: planned.reduce((sum, leg) => sum + leg.minutes, 0)
  }
}

/** How close the player is to flying the next leg, and what would get them there. */
export type Readiness =
  /** The sim isn't running. Lists aircraft already parked at the start. */
  | { kind: 'offline'; parkedHere: AirframeRecord[] }
  /** The loaded aircraft is sitting at the start of the leg. */
  | { kind: 'ready'; aircraftName: string }
  /** In the air: how far to the leg's end. */
  | { kind: 'flying'; aircraftName: string | null; toGoNm: number }
  /** The loaded aircraft is somewhere else, but its save is at the start, so Restore puts it there. */
  | { kind: 'restore'; aircraftName: string; aircraftKey: string }
  /** The loaded aircraft is somewhere else. Lists aircraft parked at the start. */
  | { kind: 'elsewhere'; aircraftName: string | null; here: LiveSim['nearAirport']; parkedHere: AirframeRecord[] }

export function readiness(leg: Leg, live: LiveSim, airframes: AirframeRecord[]): Readiness {
  const parkedHere = airframes.filter((record) => isAt(leg.from, parkedAt(record)))
  const position = live.lat !== null && live.lon !== null ? { lat: live.lat, lon: live.lon } : null
  if (!live.connected || !position) return { kind: 'offline', parkedHere }

  if (live.onGround === false) {
    return { kind: 'flying', aircraftName: live.aircraftName, toGoNm: distanceNm(position.lat, position.lon, leg.to.lat, leg.to.lon) }
  }
  if (isAt(leg.from, position)) return { kind: 'ready', aircraftName: live.aircraftName ?? 'your aircraft' }

  const loaded = airframes.find((record) => record.key === live.aircraftKey)
  if (loaded && live.aircraftName && isAt(leg.from, parkedAt(loaded))) {
    return { kind: 'restore', aircraftName: live.aircraftName, aircraftKey: loaded.key }
  }
  return { kind: 'elsewhere', aircraftName: live.aircraftName, here: live.nearAirport, parkedHere }
}

/**
 * What to call each aircraft: the player's name for it, or its title, with the livery added when two
 * aircraft would otherwise read the same.
 */
export function aircraftLabels(records: AirframeRecord[]): Map<string, string> {
  const base = (record: AirframeRecord) => record.nickname ?? record.snapshot.aircraft.title
  const counts = new Map<string, number>()
  for (const record of records) counts.set(base(record), (counts.get(base(record)) ?? 0) + 1)
  return new Map(
    records.map((record) => {
      const name = base(record)
      const livery = record.snapshot.aircraft.livery
      return [record.key, !record.nickname && (counts.get(name) ?? 0) > 1 && livery ? `${name} (${livery})` : name]
    })
  )
}

export const hoursMinutes =(minutes: number) => {
  const total = Math.round(minutes)
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`
}
