import { airMinutes, type LogbookFlight } from '../shared/logbook'
import {
  type Airport,
  type CreateJourneyInput,
  DEFAULT_DESCENT,
  type Journey,
  type JourneySettings,
  type Leg,
  NO_LIMITS,
  type Performance,
  type ReachChoice,
  type ReachOptions,
  type RouteEdit,
  type RouteLimits,
  type Stop
} from '../shared/journey'
import type { AirportIndex } from './airports'
import { distanceNm } from './recorder'
import type { Terrain } from './terrain'

const EARTH_NM = 3440.065
const SAME_PLACE_NM = 5
const LANDED_AT_AIRPORT_NM = 3
const FIRM_LEGS = 2
const FURTHER_MIN_GAIN_NM = 30
const GAP_COST = 100
const SEARCH_WINDOW = 1.2
const MILITARY = /\b(army|air force|afb|naval|nas|marine corps|mcas|military|air base|airbase|joint base)\b/i

export const toStop = ({ ident, name, lat, lon }: Stop): Stop => ({ ident, name, lat, lon })

export function rangeNm(performance: Performance): number {
  const hours = performance.usableFuelGal / performance.burnGph - performance.reserveMinutes / 60
  return Math.max(0, hours) * performance.cruiseKts
}

export function maxLegNm({ performance, maxLegMinutes, limits }: JourneySettings): number {
  return Math.min(rangeNm(performance), (maxLegMinutes / 60) * performance.cruiseKts, limits.maxLegNm ?? Infinity)
}

export const settingsOf = ({ performance, maxLegMinutes, limits, descent }: Journey): JourneySettings => ({
  performance,
  maxLegMinutes,
  limits,
  descent
})

/** What terrain and water make of a direct leg, against the player's limits. */
function legConditions(from: Stop, to: Stop, { limits }: JourneySettings, terrain: Terrain | undefined) {
  if (!terrain) return { highestTerrainFt: null, longestWaterNm: null, aboveCeiling: false, overWater: false }
  const { highestFt, longestWaterNm } = terrain.profile(from, to)
  return {
    highestTerrainFt: highestFt,
    longestWaterNm,
    aboveCeiling: limits.maxAltitudeFt !== null && highestFt + limits.terrainClearanceFt > limits.maxAltitudeFt,
    overWater: limits.maxWaterNm !== null && longestWaterNm > limits.maxWaterNm
  }
}

function bearing(a: Stop, b: Pick<Stop, 'lat' | 'lon'>): number {
  const toRad = Math.PI / 180
  const dLon = (b.lon - a.lon) * toRad
  const y = Math.sin(dLon) * Math.cos(b.lat * toRad)
  const x =
    Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) - Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos(dLon)
  return Math.atan2(y, x)
}

/** Where a point sits relative to the great circle from start to end. */
export function trackPosition(start: Stop, end: Stop, point: Pick<Stop, 'lat' | 'lon'>) {
  const angular = distanceNm(start.lat, start.lon, point.lat, point.lon) / EARTH_NM
  const relative = bearing(start, point) - bearing(start, end)
  const cross = Math.asin(Math.sin(angular) * Math.sin(relative))
  const along = Math.acos(Math.min(1, Math.cos(angular) / Math.cos(cross))) * Math.sign(Math.cos(relative) || 1)
  return { alongNm: along * EARTH_NM, crossNm: Math.abs(cross) * EARTH_NM }
}

function usable(airport: Airport, performance: Performance, limits: RouteLimits): boolean {
  return (
    // 0 means no land runway on record, so the planner never picks it on its own.
    airport.runwayFt > 0 &&
    airport.runwayFt >= performance.minRunwayFt &&
    (!performance.needsHardSurface || airport.hardSurface) &&
    (limits.maxAirportElevationFt === null || airport.elevationFt <= limits.maxAirportElevationFt)
  )
}

/** Lower is better. Fuel is more likely at bigger, paved fields. */
function stopQuality(airport: Airport): number {
  if (MILITARY.test(airport.name)) return 3
  if (airport.size === 'medium') return 0
  if (airport.size === 'large') return 0.1
  return airport.hardSurface ? 0.5 : 1.5
}

/** Re-planning after an edit checks mostly the same legs again, so answers are kept per terrain and limits. */
interface LimitCache {
  broken: Map<string, boolean>
  excess: Map<string, number>
}
const limitCaches = new WeakMap<Terrain, Map<string, LimitCache>>()
const LIMIT_CACHE_SIZE = 300_000
/** How much going over a limit is worth an extra stop to avoid. */
const FEET_PER_STOP = 300
const WATER_NM_PER_STOP = 10
function limitCacheFor(terrain: Terrain, limitsKey: string): LimitCache {
  let byLimits = limitCaches.get(terrain)
  if (!byLimits) limitCaches.set(terrain, (byLimits = new Map()))
  let cache = byLimits.get(limitsKey)
  if (!cache) byLimits.set(limitsKey, (cache = { broken: new Map(), excess: new Map() }))
  return cache
}
/** Airport codes are unique and cheap to join. Points that aren't airports need their position. */
const stopKey = (stop: Stop) => (stop.ident === 'OFF-FIELD' || stop.ident === 'HERE' ? `${stop.ident}@${stop.lat},${stop.lon}` : stop.ident)

const corridorWidth =(legNm: number) => Math.max(50, Math.min(200, legNm * 0.25))

/** Picks the fewest, evenest, best-quality stops between two points. Always returns a route. */
export function planStops(from: Stop, to: Stop, airports: Airport[], settings: JourneySettings, terrain?: Terrain): Stop[] {
  const { performance, limits } = settings
  const limit = maxLegNm(settings)
  const total = distanceNm(from.lat, from.lon, to.lat, to.lon)
  const checksTerrain = terrain !== undefined && (limits.maxAltitudeFt !== null || limits.maxWaterNm !== null)
  const giveUp = {
    aboveFt: limits.maxAltitudeFt === null ? Infinity : limits.maxAltitudeFt - limits.terrainClearanceFt,
    waterNm: limits.maxWaterNm ?? Infinity
  }
  const cache = terrain
    ? limitCacheFor(terrain, `${giveUp.aboveFt},${giveUp.waterNm}`)
    : { broken: new Map<string, boolean>(), excess: new Map<string, number>() }
  const remember = <T,>(map: Map<string, T>, key: string, value: T) => {
    if (map.size > LIMIT_CACHE_SIZE) map.clear()
    map.set(key, value)
    return value
  }
  const keyOf = (a: Stop, b: Stop) => `${stopKey(a)}>${stopKey(b)}`
  /** Quick: the walk stops as soon as a limit is broken. */
  function breaksLimits(a: Stop, b: Stop): boolean {
    const key = keyOf(a, b)
    const known = cache.broken.get(key)
    if (known !== undefined) return known
    const { highestFt, longestWaterNm } = terrain!.profile(a, b, giveUp)
    return remember(cache.broken, key, highestFt > giveUp.aboveFt || longestWaterNm > giveUp.waterNm)
  }
  /** How far over the limits a leg goes, in stops' worth. Needs the whole walk. */
  function excess(a: Stop, b: Stop): number {
    const key = keyOf(a, b)
    const known = cache.excess.get(key)
    if (known !== undefined) return known
    const { highestFt, longestWaterNm } = terrain!.profile(a, b)
    const over = Math.max(0, highestFt - giveUp.aboveFt) / FEET_PER_STOP + Math.max(0, longestWaterNm - giveUp.waterNm) / WATER_NM_PER_STOP
    return remember(cache.excess, key, over)
  }
  if (total <= limit && (!checksTerrain || !breaksLimits(from, to))) return []

  const width = corridorWidth(limit)
  const candidates = airports
    .filter((a) => a.ident !== from.ident && a.ident !== to.ident && usable(a, performance, limits))
    .map((airport) => ({ airport, ...trackPosition(from, to, airport) }))
    .filter((c) => c.crossNm <= width && c.alongNm > 0 && c.alongNm < total)
    .sort((a, b) => a.alongNm - b.alongNm)

  const nodes = [
    { stop: from, along: 0, quality: 0 },
    ...candidates.map((c) => ({ stop: toStop(c.airport), along: c.alongNm, quality: stopQuality(c.airport) })),
    { stop: to, along: total, quality: 0 }
  ]

  const cost = new Array<number>(nodes.length).fill(Infinity)
  const previous = new Array<number>(nodes.length).fill(-1)
  cost[0] = 0

  const last = nodes.length - 1
  for (let i = 1; i < nodes.length; i++) {
    for (let j = i - 1; j >= 0; j--) {
      if (j < i - 1 && nodes[i].along - nodes[j].along > limit * SEARCH_WINDOW) break
      const d = distanceNm(nodes[j].stop.lat, nodes[j].stop.lon, nodes[i].stop.lat, nodes[i].stop.lon)
      // An over-long hop is only chosen when geography leaves nothing else, such as an ocean.
      let edge = d <= limit ? 1 + 0.3 * (1 - d / limit) ** 2 + nodes[i].quality * 0.2 : GAP_COST + d
      if (limits.minLegNm !== null && d < limits.minLegNm && !(j === 0 && i === last)) edge += 0.5 + 2 * (1 - d / limits.minLegNm)
      if (cost[j] + edge >= cost[i]) continue
      // Terrain and water are checked last because they are the slowest to work out.
      // Grows with how far over the limit a leg goes, not with its length, so an unavoidable
      // crossing is made where it's lowest without dragging short hops in around it.
      if (checksTerrain && breaksLimits(nodes[j].stop, nodes[i].stop)) {
        edge += GAP_COST
        if (cost[j] + edge >= cost[i]) continue
        edge += excess(nodes[j].stop, nodes[i].stop)
      }
      if (cost[j] + edge < cost[i]) {
        cost[i] = cost[j] + edge
        previous[i] = j
      }
    }
  }

  const stops: Stop[] = []
  for (let at = previous[nodes.length - 1]; at > 0; at = previous[at]) stops.unshift(nodes[at].stop)
  return stops
}

function buildLeg(from: Stop, to: Stop, settings: JourneySettings, terrain: Terrain | undefined, pinned: boolean, index: number): Leg {
  const { performance, maxLegMinutes, limits } = settings
  const distance = distanceNm(from.lat, from.lon, to.lat, to.lon)
  const minutes = (distance / performance.cruiseKts) * 60
  return {
    id: `planned-${index}-${from.ident}-${to.ident}`,
    from,
    to,
    status: 'planned',
    distanceNm: distance,
    minutes,
    fuelGal: (minutes / 60) * performance.burnGph,
    beyondRange: distance > rangeNm(performance) + 0.5,
    beyondSession: minutes > maxLegMinutes + 0.5 || (limits.maxLegNm !== null && distance > limits.maxLegNm + 0.5),
    belowMinimum: limits.minLegNm !== null && distance < limits.minLegNm - 0.5,
    ...legConditions(from, to, settings, terrain),
    pinned,
    confidence: index < FIRM_LEGS ? 'firm' : 'tentative',
    flightId: null,
    aircraft: null
  }
}

export function currentStop(journey: Journey): Stop {
  return journey.legs.findLast((leg) => leg.status === 'flown')?.to ?? journey.origin
}

/** Replaces the future with a fresh plan. Flown legs are never touched. */
export function reflow(journey: Journey, airports: Airport[], terrain?: Terrain): Journey {
  const flown = journey.legs.filter((leg) => leg.status === 'flown')
  const start = currentStop(journey)
  if (start.ident === journey.destination.ident) return { ...journey, legs: flown, status: 'complete', via: [] }

  const settings = settingsOf(journey)
  const choices = airports.filter((airport) => !journey.avoid.includes(airport.ident))
  const targets = [...journey.via, journey.destination]
  const planned: Leg[] = []
  let from = start
  for (const target of targets) {
    const stops = [...planStops(from, target, choices, settings, terrain), target]
    for (const stop of stops) {
      planned.push(buildLeg(from, stop, settings, terrain, stop === target, planned.length))
      from = stop
    }
  }
  return { ...journey, status: 'active', legs: [...flown, ...planned] }
}

function requireAirport(index: AirportIndex, ident: string): Airport {
  const airport = index.get(ident)
  if (!airport) throw new Error(`Couldn't find an airport called ${ident}.`)
  return airport
}

/** Rejects numbers the planner can't work with. Limits left blank are off. */
export function checkSettings(settings: JourneySettings): JourneySettings {
  const { performance: p, maxLegMinutes, limits } = settings
  const positive = (value: number, label: string) => {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} needs to be more than zero.`)
  }
  const notNegative = (value: number, label: string) => {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label} can't be negative.`)
  }
  positive(p.cruiseKts, 'Cruise speed')
  positive(p.burnGph, 'Fuel burn')
  positive(p.usableFuelGal, 'Usable fuel')
  notNegative(p.reserveMinutes, 'Reserve')
  notNegative(p.minRunwayFt, 'Minimum runway')
  positive(maxLegMinutes, 'Longest leg')
  notNegative(limits.terrainClearanceFt, 'Terrain clearance')
  const optional: [number | null, string][] = [
    [limits.maxLegNm, 'Longest leg distance'],
    [limits.minLegNm, 'Shortest leg'],
    [limits.maxAltitudeFt, 'Highest altitude'],
    [limits.maxAirportElevationFt, 'Highest airport'],
    [limits.maxWaterNm, 'Longest water crossing']
  ]
  for (const [value, label] of optional) if (value !== null) positive(value, label)
  if (limits.minLegNm !== null && limits.minLegNm >= maxLegNm(settings)) {
    throw new Error('Shortest leg needs to be less than the longest leg this aircraft can fly.')
  }
  const { descent } = settings
  positive(descent.minutesBefore, 'Minutes before top of descent')
  notNegative(descent.arriveAboveFieldFt, 'Height above the field')
  if (!(descent.angleDeg >= 1 && descent.angleDeg <= 10)) throw new Error('Descent angle needs to be between 1° and 10°.')
  return settings
}

export function createJourney(input: CreateJourneyInput, index: AirportIndex, id: string, now: number, terrain?: Terrain): Journey {
  const origin = toStop(requireAirport(index, input.originIdent))
  const destination = toStop(requireAirport(index, input.destinationIdent))
  const settings = checkSettings({
    performance: input.performance,
    maxLegMinutes: input.maxLegMinutes,
    limits: input.limits ?? NO_LIMITS,
    descent: input.descent ?? DEFAULT_DESCENT
  })
  return reflow(
    {
      id,
      name: input.name.trim() || `${origin.ident} to ${destination.ident}`,
      createdAt: now,
      lastOpenedAt: now,
      status: 'active',
      origin,
      destination,
      via: [],
      avoid: [],
      ...settings,
      legs: []
    },
    index.all,
    terrain
  )
}

/** Changes the aircraft numbers or route limits, and re-plans what hasn't been flown. */
export function updateSettings(journey: Journey, settings: JourneySettings, airports: Airport[], terrain?: Terrain): Journey {
  return reflow({ ...journey, ...checkSettings(settings) }, airports, terrain)
}

const between = (a: Stop, b: Stop) => distanceNm(a.lat, a.lon, b.lat, b.lon)

/** Adds a chosen stop where it costs the least extra distance, keeping the player's order. */
export function addVia(journey: Journey, stop: Stop, airports: Airport[], terrain?: Terrain): Journey {
  const via = journey.via.filter((v) => v.ident !== stop.ident)
  const points = [currentStop(journey), ...via, journey.destination]
  let position = 0
  let leastDetour = Infinity
  for (let i = 0; i < points.length - 1; i++) {
    const detour = between(points[i], stop) + between(stop, points[i + 1]) - between(points[i], points[i + 1])
    if (detour < leastDetour) {
      leastDetour = detour
      position = i
    }
  }
  via.splice(position, 0, stop)
  return reflow({ ...journey, via, avoid: journey.avoid.filter((ident) => ident !== stop.ident) }, airports, terrain)
}

/** Takes a stop off the route, and keeps the planner from choosing it again. */
export function removeVia(journey: Journey, ident: string, airports: Airport[], terrain?: Terrain): Journey {
  const via = journey.via.filter((v) => v.ident !== ident)
  return reflow({ ...journey, via, avoid: [...new Set([...journey.avoid, ident])] }, airports, terrain)
}

function replaceStop(journey: Journey, ident: string, stop: Stop, airports: Airport[], terrain?: Terrain): Journey {
  const isOtherChoice = (s: Stop) => s.ident !== stop.ident && journey.via.some((v) => v.ident === s.ident)
  const via = journey.legs
    .filter((leg) => leg.status === 'planned')
    .flatMap((leg) => (leg.to.ident === ident ? [stop] : isOtherChoice(leg.to) ? [leg.to] : []))
  const avoid = [...new Set([...journey.avoid.filter((a) => a !== stop.ident), ident])]
  return reflow({ ...journey, via, avoid }, airports, terrain)
}

function moveStop(journey: Journey, ident: string, offset: -1 | 1, airports: Airport[], terrain?: Terrain): Journey {
  const from = journey.via.findIndex((v) => v.ident === ident)
  const to = from + offset
  if (from < 0 || to < 0 || to >= journey.via.length) return journey
  const via = [...journey.via]
  ;[via[from], via[to]] = [via[to], via[from]]
  return reflow({ ...journey, via }, airports, terrain)
}

/**
 * Moves one stop to a different airport. Every stop before it is kept exactly where it is.
 * After it, 'keep' keeps every stop, and 'replan' plans everything from the new stop onwards afresh.
 */
function dragStop(journey: Journey, ident: string, stop: Stop, rest: 'keep' | 'replan', airports: Airport[], terrain?: Terrain): Journey {
  const ahead = journey.legs.filter((leg) => leg.status === 'planned').map((leg) => leg.to)
  const at = ahead.findIndex((s) => s.ident === ident)
  if (at < 0 || ident === journey.destination.ident) throw new Error(`${ident} isn't a stop you still have to fly to.`)
  if (ahead.some((s, i) => i !== at && s.ident === stop.ident)) throw new Error(`${stop.ident} is already on your route.`)

  const later = rest === 'keep' ? ahead.slice(at + 1, -1) : []
  const via = [...ahead.slice(0, at), stop, ...later]
  const avoid = [...new Set([...journey.avoid.filter((a) => a !== stop.ident), ident])]
  return reflow({ ...journey, via, avoid }, airports, terrain)
}

function withEndpoints(journey: Journey, origin: Stop, destination: Stop, airports: Airport[], terrain?: Terrain): Journey {
  const name = journey.name === `${journey.origin.ident} to ${journey.destination.ident}` ? `${origin.ident} to ${destination.ident}` : journey.name
  const via = journey.via.filter((v) => v.ident !== origin.ident && v.ident !== destination.ident)
  return reflow({ ...journey, name, origin, destination, via }, airports, terrain)
}

function requireNewStop(journey: Journey, stop: Stop): void {
  if (stop.ident === journey.destination.ident) throw new Error(`${stop.ident} is already your destination.`)
  if (stop.ident === currentStop(journey).ident) throw new Error(`You're already at ${stop.ident}.`)
}

/** Applies one change the player made to the part of the route they haven't flown. */
export function editRoute(journey: Journey, edit: RouteEdit, index: AirportIndex, terrain?: Terrain): Journey {
  const airports = index.all
  if (edit.kind === 'reset') return reflow({ ...journey, via: [], avoid: [] }, airports, terrain)
  if (edit.kind === 'remove') return removeVia(journey, edit.ident, airports, terrain)
  if (edit.kind === 'move') return moveStop(journey, edit.ident, edit.offset, airports, terrain)

  const stop = toStop(requireAirport(index, edit.kind === 'replace' || edit.kind === 'drag' ? edit.withIdent : edit.ident))
  switch (edit.kind) {
    case 'add':
      requireNewStop(journey, stop)
      return addVia(journey, stop, airports, terrain)
    case 'replace':
      requireNewStop(journey, stop)
      return replaceStop(journey, edit.ident, stop, airports, terrain)
    case 'drag':
      requireNewStop(journey, stop)
      return dragStop(journey, edit.ident, stop, edit.rest, airports, terrain)
    case 'origin':
      if (journey.legs.some((leg) => leg.status === 'flown')) throw new Error('You have already left the first airport.')
      if (stop.ident === journey.destination.ident) throw new Error(`${stop.ident} is already your destination.`)
      return withEndpoints(journey, stop, journey.destination, airports, terrain)
    case 'destination':
      if (stop.ident === currentStop(journey).ident) throw new Error(`You're already at ${stop.ident}.`)
      return withEndpoints(journey, journey.origin, stop, airports, terrain)
  }
}

/** Records a finished flight on the Journey, and re-plans from wherever it ended. */
export function applyFlight(journey: Journey, flight: LogbookFlight, index: AirportIndex, terrain?: Terrain): Journey | null {
  if (journey.status !== 'active' || flight.status !== 'complete' || !flight.destination) return null
  if (journey.legs.some((leg) => leg.flightId === flight.id)) return null

  const from = currentStop(journey)
  if (distanceNm(from.lat, from.lon, flight.origin.lat, flight.origin.lon) > SAME_PLACE_NM) return null

  const { lat, lon } = flight.destination
  const airport = index.nearest(lat, lon, LANDED_AT_AIRPORT_NM)
  const to: Stop = airport ? toStop(airport) : { ident: 'OFF-FIELD', name: 'Off-airport landing', lat, lon }
  if (to.ident === from.ident) return null

  const minutes = flight.landedAt ? (airMinutes(flight) ?? 0) : 0
  const flown: Leg = {
    id: `flown-${flight.id}`,
    from,
    to,
    status: 'flown',
    distanceNm: flight.distanceNm,
    minutes,
    fuelGal: flight.fuelStartGal - flight.fuelEndGal,
    beyondRange: false,
    beyondSession: false,
    pinned: false,
    confidence: 'firm',
    flightId: flight.id,
    aircraft: flight.aircraft?.title ?? null
  }
  const legs = [...journey.legs.filter((leg) => leg.status === 'flown'), flown]
  const reached = journey.via.findIndex((v) => v.ident === to.ident)
  const via = journey.via.slice(reached + 1)
  return reflow({ ...journey, legs, via }, index.all, terrain)
}

export interface ReachInput {
  lat: number
  lon: number
  fuelGal: number
  burnGph: number
  gsKts: number
}

/** Compares real fuel and groundspeed to the plan. Only ever offers options. */
export function reachOptions(journey: Journey, input: ReachInput, airports: Airport[]): ReachOptions | null {
  const next = journey.legs.find((leg) => leg.status === 'planned')
  if (!next || input.burnGph <= 0 || input.gsKts <= 0) return null

  const here = { ident: 'HERE', name: 'Current position', lat: input.lat, lon: input.lon }
  const { reserveMinutes } = journey.performance
  const enduranceMinutes = (input.fuelGal / input.burnGph) * 60
  const reachNm = (Math.max(0, enduranceMinutes - reserveMinutes) / 60) * input.gsKts
  const reserveAt = (distance: number) => enduranceMinutes - (distance / input.gsKts) * 60

  const distanceToPlanned = distanceNm(input.lat, input.lon, next.to.lat, next.to.lon)
  const reserveAtPlanned = reserveAt(distanceToPlanned)
  const canReachPlanned = reserveAtPlanned >= reserveMinutes
  const plannedAlong = trackPosition(here, journey.destination, next.to).alongNm

  const width = corridorWidth(reachNm)
  const dryNm = (enduranceMinutes / 60) * input.gsKts
  const inFuelRange = airports
    .filter((a) => usable(a, journey.performance, journey.limits) && a.ident !== next.to.ident && (a.size !== 'small' || a.hardSurface))
    .map((airport) => ({
      airport,
      distance: distanceNm(input.lat, input.lon, airport.lat, airport.lon),
      ...trackPosition(here, journey.destination, airport)
    }))
    .filter((o) => o.distance <= dryNm)
  const options = inFuelRange.filter(
    (o) => o.distance <= reachNm && o.crossNm <= width && o.alongNm > 0 && !journey.avoid.includes(o.airport.ident)
  )

  const choice = (o: (typeof options)[number]): ReachChoice => ({
    stop: toStop(o.airport),
    distanceNm: o.distance,
    reserveMinutes: reserveAt(o.distance)
  })
  const furthest = (list: typeof options) => list.reduce<(typeof options)[number] | null>((best, o) => (!best || o.alongNm > best.alongNm ? o : best), null)

  const beyond = canReachPlanned ? furthest(options.filter((o) => o.alongNm >= plannedAlong + FURTHER_MIN_GAIN_NM)) : null
  // With no stop ahead inside reserves, the closest field in any direction is the useful answer.
  const nearest = inFuelRange.reduce<(typeof options)[number] | null>((best, o) => (!best || o.distance < best.distance ? o : best), null)
  const short = canReachPlanned ? null : (furthest(options.filter((o) => o.alongNm < plannedAlong)) ?? nearest)

  return {
    journeyId: journey.id,
    plannedStop: next.to,
    distanceToPlannedNm: distanceToPlanned,
    reserveAtPlannedMinutes: reserveAtPlanned,
    canReachPlanned,
    further: beyond ? choice(beyond) : null,
    closer: short ? choice(short) : null
  }
}
