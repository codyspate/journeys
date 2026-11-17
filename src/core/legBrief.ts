import type { Arrival, ArrivalRunway, CruiseHint, LegBrief, NavLogRow, ProfilePoint, Wind } from '../shared/brief'
import type { Airport, Journey, Leg, Stop, Vor } from '../shared/journey'
import { trackPosition } from './planner'
import { distanceNm } from './recorder'
import { alongGreatCircle, type LatLon } from './terrain'

/** A town from GeoNames, for visual checkpoints. */
export interface Town {
  name: string
  lat: number
  lon: number
  population: number
}

/** One row of resources/places.json, built by scripts/build-places.mjs. */
export type TownRow = [string, number, number, number, string]
export const townsFromRows = (rows: TownRow[]): Town[] => rows.map(([name, lat, lon, population]) => ({ name, lat, lon, population }))

/** What the brief needs from the terrain grid. */
export interface Ground {
  elevationFt(point: LatLon): number
  isWater(point: LatLon): boolean
}

export interface BriefSources {
  airports: Airport[]
  vors: Vor[]
  towns: Town[]
  ground?: Ground
  wind: Wind | null
}

const PROFILE_POINTS = 160
/** Checkpoints are looked for about this often, within a window either side. */
const CHECKPOINT_NM = 12
const CHECKPOINT_MIN_NM = 8
const CHECKPOINT_MAX_NM = 18
/** How far off the line a checkpoint can be and still be easy to see; further only where there's nothing closer. */
const CHECKPOINT_OFF_TRACK_NM = 4
const CHECKPOINT_FAR_OFF_TRACK_NM = 8
/** Rows closer together than this are one place, such as a VOR on the airport. */
const SAME_ROW_NM = 1
/** No checkpoint this close to the stretch's end, which is a row of its own. */
const END_CLEAR_NM = 5
/** The VFR hemispheric rule only applies more than 3,000 ft above the ground. */
const LOWEST_VFR_CRUISE_FT = 3500
/** Variation from the nearest VOR is close enough within this distance. */
const VARIATION_FROM_NM = 300
/** Less wind than this isn't worth choosing a runway for. */
const CALM_KTS = 3
const toRad = Math.PI / 180

function trueBearing(a: LatLon, b: LatLon): number {
  const dLon = (b.lon - a.lon) * toRad
  const y = Math.sin(dLon) * Math.cos(b.lat * toRad)
  const x = Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) - Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos(dLon)
  return (Math.atan2(y, x) / toRad + 360) % 360
}

const wrap = (deg: number) => {
  const d = Math.round(((deg % 360) + 360) % 360)
  return d === 0 ? 360 : d
}

/** The variation at a point, from the nearest VOR, east positive. null where no VOR is near enough to say. */
export function variationNear(point: LatLon, vors: Vor[]): number | null {
  let best: Vor | null = null
  let bestNm = VARIATION_FROM_NM
  for (const vor of vors) {
    if (Math.abs(vor.lat - point.lat) > 6) continue
    const nm = distanceNm(point.lat, point.lon, vor.lat, vor.lon)
    if (nm < bestNm) {
      best = vor
      bestNm = nm
    }
  }
  return best ? best.magVarDeg : null
}

/** Heading and groundspeed for a true course, airspeed and wind. Null heading if the wind is too strong to hold the course. */
export function windTriangle(courseTrue: number, tasKts: number, wind: Wind | null): { headingTrue: number | null; gsKts: number } {
  if (!wind || wind.kts <= 0) return { headingTrue: null, gsKts: tasKts }
  const angle = (wind.fromTrue - courseTrue) * toRad
  const cross = wind.kts * Math.sin(angle)
  const head = wind.kts * Math.cos(angle)
  if (Math.abs(cross) >= tasKts) return { headingTrue: null, gsKts: Math.max(1, tasKts - head) }
  const correction = Math.asin(cross / tasKts)
  return { headingTrue: (courseTrue + correction / toRad + 360) % 360, gsKts: Math.max(1, tasKts * Math.cos(correction) - head) }
}

/**
 * The lowest hemispheric VFR altitude clear of the floor: odd thousands plus 500 eastbound, even westbound.
 * Kept at or under the ceiling when there is one, even if that means not clearing the floor.
 */
export function vfrAltitude(eastbound: boolean, floorFt: number, ceilingFt: number | null): { altitudeFt: number; heldByCeiling: boolean } {
  const fits = (thousands: number) => (thousands % 2 === 1) === eastbound
  let thousands = Math.max(0, Math.ceil((Math.max(floorFt, LOWEST_VFR_CRUISE_FT) - 500) / 1000))
  if (!fits(thousands)) thousands += 1
  const altitudeFt = thousands * 1000 + 500
  if (ceilingFt === null || altitudeFt <= ceilingFt) return { altitudeFt, heldByCeiling: false }
  let under = Math.floor((ceilingFt - 500) / 1000)
  if (!fits(under)) under -= 1
  return { altitudeFt: Math.max(500, under * 1000 + 500), heldByCeiling: true }
}

/** The points the leg is flown through: departure, any VORs, arrival. */
function pathOf(leg: Leg): (Stop & { vor?: number })[] {
  const fixes = (leg.vorRoute ?? []).map((fix) => ({ ident: fix.ident, name: fix.name, lat: fix.lat, lon: fix.lon, vor: fix.freqMhz }))
  return [leg.from, ...fixes, leg.to]
}

function profileOf(path: LatLon[], ground: Ground | undefined): { profile: ProfilePoint[]; totalNm: number } {
  const totalNm = path.slice(1).reduce((sum, p, i) => sum + distanceNm(path[i].lat, path[i].lon, p.lat, p.lon), 0)
  if (!ground) return { profile: [], totalNm }
  // Fine samples, then the highest in each bucket, so a narrow ridge never drops out of the picture.
  const samples: ProfilePoint[] = []
  let base = 0
  path.slice(1).forEach((to, i) => {
    let along = base
    for (const point of alongGreatCircle(path[i], to, 1)) {
      along += point.stepNm
      samples.push({ alongNm: along, groundFt: ground.elevationFt(point), water: ground.isWater(point) })
    }
    base = along
  })
  const bucketNm = totalNm / PROFILE_POINTS || 1
  const profile: ProfilePoint[] = []
  for (const sample of samples) {
    const bucket = Math.min(PROFILE_POINTS - 1, Math.floor(sample.alongNm / bucketNm))
    const current = profile[bucket]
    if (!current || sample.groundFt > current.groundFt) profile[bucket] = { ...sample, alongNm: (bucket + 0.5) * bucketNm }
  }
  return { profile: profile.filter(Boolean), totalNm }
}

interface Candidate {
  name: string
  kind: 'town' | 'airport'
  ident: string | null
  lat: number
  lon: number
  /** Lower is a better landmark. */
  weight: number
}

function candidatesNear(path: LatLon[], sources: BriefSources, leg: Leg): Candidate[] {
  const pad = 0.3
  const lats = path.map((p) => p.lat)
  const lons = path.map((p) => p.lon)
  const [south, north] = [Math.min(...lats) - pad, Math.max(...lats) + pad]
  const [west, east] = [Math.min(...lons) - pad, Math.max(...lons) + pad]
  const inBox = (p: LatLon) => p.lat >= south && p.lat <= north && p.lon >= west && p.lon <= east
  const towns: Candidate[] = sources.towns
    .filter(inBox)
    .map((t) => ({ name: t.name, kind: 'town', ident: null, lat: t.lat, lon: t.lon, weight: -Math.log10(Math.max(1000, t.population)) }))
  const airports: Candidate[] = sources.airports
    .filter((a) => inBox(a) && a.ident !== leg.from.ident && a.ident !== leg.to.ident && (a.runwayFt > 0 || a.size !== 'small'))
    // An airport is a good landmark; a bigger one more so.
    .map((a) => ({ name: a.name, kind: 'airport', ident: a.ident, lat: a.lat, lon: a.lon, weight: a.size === 'small' ? -3.6 : -4.6 }))
  return [...towns, ...airports]
}

/** The point a given distance along the great circle from a to b. */
function pointAlong(a: LatLon, b: LatLon, nm: number): LatLon {
  const total = distanceNm(a.lat, a.lon, b.lat, b.lon)
  if (total < 1e-6) return a
  const δ = total / 3440.065
  const f = Math.min(1, Math.max(0, nm / total))
  const [φ1, λ1, φ2, λ2] = [a.lat * toRad, a.lon * toRad, b.lat * toRad, b.lon * toRad]
  const p = Math.sin((1 - f) * δ) / Math.sin(δ)
  const q = Math.sin(f * δ) / Math.sin(δ)
  const x = p * Math.cos(φ1) * Math.cos(λ1) + q * Math.cos(φ2) * Math.cos(λ2)
  const y = p * Math.cos(φ1) * Math.sin(λ1) + q * Math.cos(φ2) * Math.sin(λ2)
  const z = p * Math.sin(φ1) + q * Math.sin(φ2)
  return { lat: Math.atan2(z, Math.hypot(x, y)) / toRad, lon: Math.atan2(y, x) / toRad }
}

/**
 * Landmarks about every 12 nm along one stretch, close to the line. Each comes with the point abeam it on
 * the line, which is what the course and distance are worked out to, so the log follows the route.
 */
function checkpointsAlong(from: Stop, to: Stop, candidates: Candidate[]): { c: Candidate; abeam: LatLon }[] {
  const total = distanceNm(from.lat, from.lon, to.lat, to.lon)
  const near = candidates
    .map((c) => ({ c, ...trackPosition(from, to, c) }))
    .filter((p) => p.crossNm <= CHECKPOINT_FAR_OFF_TRACK_NM && p.alongNm > 0 && p.alongNm < total - END_CLEAR_NM)
  const picked: { c: Candidate; abeam: LatLon }[] = []
  let last = 0
  while (last + CHECKPOINT_MIN_NM < total - END_CLEAR_NM) {
    const inWindow = near.filter((p) => p.alongNm > last + CHECKPOINT_MIN_NM && p.alongNm <= last + CHECKPOINT_MAX_NM)
    const close = inWindow.filter((p) => p.crossNm <= CHECKPOINT_OFF_TRACK_NM)
    const window = close.length > 0 ? close : inWindow
    if (window.length === 0) {
      last += CHECKPOINT_NM
      continue
    }
    const score = (p: (typeof window)[number]) => p.c.weight + Math.abs(p.alongNm - (last + CHECKPOINT_NM)) / 6 + p.crossNm / 2
    const best = window.reduce((a, b) => (score(b) < score(a) ? b : a))
    picked.push({ c: best.c, abeam: pointAlong(from, to, best.alongNm) })
    last = best.alongNm
  }
  return picked
}

function navLogOf(leg: Leg, journey: Journey, sources: BriefSources): NavLogRow[] {
  const path = pathOf(leg)
  const candidates = candidatesNear(path, sources, leg)
  const { cruiseKts, burnGph } = journey.performance
  const rows: NavLogRow[] = []
  let previous: LatLon = leg.from
  let totalNm = 0
  let totalMinutes = 0
  type Place = Omit<NavLogRow, 'legNm' | 'totalNm' | 'courseDeg' | 'headingDeg' | 'gsKts' | 'legMinutes' | 'totalMinutes' | 'fuelUsedGal'>
  const add = (point: Place, onTrack: LatLon = point) => {
    const legNm = distanceNm(previous.lat, previous.lon, onTrack.lat, onTrack.lon)
    if (legNm < SAME_ROW_NM) {
      // A VOR on the departure field isn't a row; one on the arrival field becomes part of the arrival's row.
      const last = rows.at(-1)
      if (last && point.kind === 'arrival') rows[rows.length - 1] = { ...last, ...point, frequency: last.frequency ?? point.frequency }
      return
    }
    const courseTrue = trueBearing(previous, onTrack)
    const variation = variationNear(onTrack, sources.vors) ?? 0
    const { headingTrue, gsKts } = windTriangle(courseTrue, cruiseKts, sources.wind)
    const legMinutes = (legNm / gsKts) * 60
    totalNm += legNm
    totalMinutes += legMinutes
    rows.push({
      ...point,
      legNm,
      totalNm,
      courseDeg: wrap(courseTrue - variation),
      headingDeg: headingTrue === null ? null : wrap(headingTrue - variation),
      gsKts,
      legMinutes,
      totalMinutes,
      fuelUsedGal: (totalMinutes / 60) * burnGph
    })
    previous = onTrack
  }
  path.slice(1).forEach((to, i) => {
    for (const { c, abeam } of checkpointsAlong(path[i], to, candidates)) {
      add({ name: c.name, kind: c.kind, ident: c.ident, frequency: null, lat: c.lat, lon: c.lon }, abeam)
    }
    const isArrival = i === path.length - 2
    add({
      name: to.name,
      kind: isArrival ? 'arrival' : 'vor',
      ident: to.ident,
      frequency: to.vor ?? null,
      lat: to.lat,
      lon: to.lon
    })
  })
  return rows
}

function cruiseOf(leg: Leg, journey: Journey, profile: ProfilePoint[], vors: Vor[]): CruiseHint {
  const variation = variationNear({ lat: (leg.from.lat + leg.to.lat) / 2, lon: (leg.from.lon + leg.to.lon) / 2 }, vors)
  const courseDeg = wrap(trueBearing(leg.from, leg.to) - (variation ?? 0))
  const eastbound = courseDeg === 360 || courseDeg < 180
  const highestGroundFt = profile.length > 0 ? Math.max(...profile.map((p) => p.groundFt)) : (leg.highestTerrainFt ?? 0)
  const { altitudeFt, heldByCeiling } = vfrAltitude(eastbound, highestGroundFt + journey.limits.terrainClearanceFt, journey.limits.maxAltitudeFt)
  return { courseDeg, magnetic: variation !== null, eastbound, highestGroundFt, suggestedFt: altitudeFt, heldByCeiling }
}

/** Runway figures for the end most into the wind, and which end that is. */
function runwayInWind(runway: NonNullable<Airport['runways']>[number], wind: Wind | null): ArrivalRunway {
  const base = { ends: runway.ends, lengthFt: runway.lengthFt, hardSurface: runway.hardSurface }
  if (!wind || runway.headingTrue === null) return { ...base, headwindKts: null, crosswindKts: null, windEnd: null }
  const options = [
    { end: runway.ends[0], heading: runway.headingTrue },
    { end: runway.ends[1], heading: (runway.headingTrue + 180) % 360 }
  ].map((o) => {
    const angle = (wind.fromTrue - o.heading) * toRad
    return { end: o.end, head: wind.kts * Math.cos(angle), cross: Math.abs(wind.kts * Math.sin(angle)) }
  })
  const best = options[0].head >= options[1].head ? options[0] : options[1]
  return { ...base, headwindKts: best.head, crosswindKts: best.cross, windEnd: best.end }
}

function arrivalOf(leg: Leg, airports: Airport[], wind: Wind | null): Arrival | null {
  const airport = airports.find((a) => a.ident === leg.to.ident)
  if (!airport) return null
  const runways = (airport.runways ?? []).map((r) => runwayInWind(r, wind))
  const windy = wind !== null && wind.kts >= CALM_KTS
  // The most headwind, unless that runway's crosswind is far worse than another's.
  const ranked = runways
    .filter((r) => r.headwindKts !== null)
    .sort((a, b) => b.headwindKts! - b.crosswindKts! * 0.5 - (a.headwindKts! - a.crosswindKts! * 0.5))
  return {
    ident: airport.ident,
    name: airport.name,
    elevationFt: airport.elevationFt,
    patternAltitudeFt: Math.round((airport.elevationFt + 1000) / 10) * 10,
    runways,
    likely: windy && ranked[0] ? ranked[0].windEnd : null
  }
}

/** Everything on a leg's kneeboard. Suggestions only: nothing here limits what the player does. */
export function legBrief(journey: Journey, leg: Leg, sources: BriefSources): LegBrief {
  const path = pathOf(leg)
  const { profile, totalNm } = profileOf(path, sources.ground)
  return {
    legId: leg.id,
    profile,
    totalNm,
    cruise: cruiseOf(leg, journey, profile, sources.vors),
    wind: sources.wind,
    navLog: navLogOf(leg, journey, sources),
    arrival: arrivalOf(leg, sources.airports, sources.wind)
  }
}
