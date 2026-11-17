import type { LiveSim } from '../../shared/airframe'
import type { NavLogRow } from '../../shared/brief'
import type { DescentSettings, Leg } from '../../shared/journey'

const EARTH_NM = 3440.065
const FEET_PER_NM = 6076.12
const toRad = Math.PI / 180

type Point = { lat: number; lon: number }

function distanceNm(a: Point, b: Point): number {
  const h =
    Math.sin(((b.lat - a.lat) * toRad) / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(((b.lon - a.lon) * toRad) / 2) ** 2
  return 2 * EARTH_NM * Math.asin(Math.min(1, Math.sqrt(h)))
}

function bearing(a: Point, b: Point): number {
  const dLon = (b.lon - a.lon) * toRad
  const y = Math.sin(dLon) * Math.cos(b.lat * toRad)
  const x = Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) - Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos(dLon)
  return Math.atan2(y, x)
}

/** How far along, and how far off, the great circle from a to b a point is. */
function trackPosition(a: Point, b: Point, p: Point) {
  const angular = distanceNm(a, p) / EARTH_NM
  const relative = bearing(a, p) - bearing(a, b)
  const cross = Math.asin(Math.sin(angular) * Math.sin(relative))
  const along = Math.acos(Math.min(1, Math.cos(angular) / Math.cos(cross))) * Math.sign(Math.cos(relative) || 1)
  return { alongNm: along * EARTH_NM, crossNm: Math.abs(cross) * EARTH_NM }
}

/** What Home is for right now: flying a leg, about to fly one, or looking at the bigger picture. */
export type HomeMode = 'flying' | 'preflight' | 'overview'

/**
 * In the air, or a flight being logged: flying. On the ground where the next leg starts: preflight.
 * Anything else, including the sim not running: overview.
 */
export function homeMode(live: LiveSim, leg: Leg | null): HomeMode {
  if (!live.connected || live.lat === null || live.lon === null) return 'overview'
  if (live.onGround === false || live.flightId !== null) return 'flying'
  if (leg && distanceNm(leg.from, { lat: live.lat, lon: live.lon }) <= 3) return 'preflight'
  return 'overview'
}

export interface RouteProgress {
  /** Along the leg's route, through its VORs if it has them. */
  alongNm: number
  totalNm: number
  toGoNm: number
  /** How far off the route the aircraft is. */
  offRouteNm: number
}

/** Where the aircraft is along a leg's planned route. */
export function routeProgress(leg: Pick<Leg, 'from' | 'to' | 'vorRoute'>, position: Point): RouteProgress {
  const path: Point[] = [leg.from, ...(leg.vorRoute ?? []), leg.to]
  let base = 0
  let best = { alongNm: 0, crossNm: Infinity }
  for (let i = 1; i < path.length; i++) {
    const length = distanceNm(path[i - 1], path[i])
    const { alongNm, crossNm } = trackPosition(path[i - 1], path[i], position)
    const clamped = Math.min(length, Math.max(0, alongNm))
    // Off the end of a stretch counts the distance to its nearer end.
    const off = alongNm < 0 || alongNm > length ? Math.hypot(crossNm, alongNm - clamped) : crossNm
    if (off < best.crossNm) best = { alongNm: base + clamped, crossNm: off }
    base += length
  }
  return { alongNm: best.alongNm, totalNm: base, toGoNm: Math.max(0, base - best.alongNm), offRouteNm: best.crossNm }
}

/** The first checkpoint on the nav log not yet passed, or null past the last. */
export function nextCheckpoint(navLog: NavLogRow[], alongNm: number): { row: NavLogRow; index: number; inNm: number } | null {
  const index = navLog.findIndex((row) => row.totalNm > alongNm + 0.5)
  return index < 0 ? null : { row: navLog[index], index, inNm: navLog[index].totalNm - alongNm }
}

export interface DescentAhead {
  /** How far out the descent starts from the arrival. */
  descentNm: number
  /** How far until descent starts; 0 or less means it's time. */
  toTodNm: number
  /** At the current groundspeed, in sim minutes. */
  minutes: number | null
  levelOffFt: number
}

/** Where to start down for the arrival, from the altitude and groundspeed now. */
export function descentAhead(altFt: number, gsKts: number | null, toGoNm: number, fieldElevationFt: number, settings: DescentSettings): DescentAhead {
  const levelOffFt = fieldElevationFt + settings.arriveAboveFieldFt
  const feetPerNm = Math.tan(settings.angleDeg * toRad) * FEET_PER_NM
  const descentNm = Math.max(0, altFt - levelOffFt) / feetPerNm
  const toTodNm = toGoNm - descentNm
  return { descentNm, toTodNm, minutes: gsKts && gsKts > 30 ? (toTodNm / gsKts) * 60 : null, levelOffFt }
}

/** Minutes as h:mm. */
export const clock = (minutes: number) => `${Math.floor(minutes / 60)}:${String(Math.round(minutes % 60)).padStart(2, '0')}`
