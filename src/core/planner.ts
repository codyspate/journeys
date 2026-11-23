import { airMinutes, type LogbookFlight } from '../shared/logbook'
import {
  type Airport,
  type CreateJourneyInput,
  type Journey,
  type JourneySettings,
  type Leg,
  NO_LIMITS,
  type Performance,
  type ReachChoice,
  type ReachOptions,
  type RouteEdit,
  type RouteLimits,
  type RadioRouteChoice,
  type Stop,
  type StationRef,
  type Vor
} from '../shared/journey'
import type { AirportIndex } from './airports'
import { distanceNm } from './recorder'
import type { Terrain } from './terrain'
import { isNdb, receptionNm, toFix, VorRouter, type VorRoute } from './vor'

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

export const settingsOf = ({ performance, maxLegMinutes, limits }: Journey): JourneySettings => ({
  performance,
  maxLegMinutes,
  limits
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
export function planStops(from: Stop, to: Stop, airports: Airport[], settings: JourneySettings, terrain?: Terrain, vors?: Vor[]): Stop[] {
  return planSegment(from, to, airports, settings, terrain, vors).stops
}

/** VORs that could help between two points: near the line, allowing for how far they reach. */
function vorsNear(from: Stop, to: Stop, vors: Vor[], widthNm: number): Vor[] {
  const total = distanceNm(from.lat, from.lon, to.lat, to.lon)
  const margin = widthNm + 130
  return vors.filter((vor) => {
    const { alongNm, crossNm } = trackPosition(from, to, vor)
    return crossNm <= margin && alongNm > -margin && alongNm < total + margin
  })
}

interface Segment {
  stops: Stop[]
  /** One per leg with radio navigation on, in order; undefined when it's off. */
  routes?: (VorRoute | null)[]
}

/** Within this of where a station was chosen counts as the same station. */
const SAME_STATION_DEG = 0.02

const sameStation = (vor: Vor, ref: StationRef) =>
  vor.ident === ref.ident && Math.abs(vor.lat - ref.lat) < SAME_STATION_DEG && Math.abs(vor.lon - ref.lon) < SAME_STATION_DEG

/** The player's chosen stations as a route. Stations no longer in the data are left out. */
function chosenRoute(from: Stop, to: Stop, choice: RadioRouteChoice, vors: Vor[], altitudeFt: number | null): VorRoute {
  const stations = choice.stations.flatMap((ref) => vors.find((vor) => sameStation(vor, ref)) ?? [])
  const fixes = stations.map((vor) => toFix(vor, receptionNm(vor, altitudeFt)))
  const points = [from, ...fixes, to]
  const distanceNm = points.slice(1).reduce((sum, p, i) => sum + between(points[i], p), 0)
  return { fixes, distanceNm, chosen: true }
}

/** How wide, either side, a stretch is searched again when the usual corridor leaves a leg too long to fly. */
const WIDE_CORRIDOR_NM = 900

/**
 * Plans between two points in a corridor along the direct line. Where that leaves a hop longer than the
 * aircraft can fly, such as an ocean crossing, that stretch is planned again across a much wider area,
 * so island chains well off the line (Greenland and Iceland, say) can break it up.
 */
function planSegment(
  from: Stop,
  to: Stop,
  airports: Airport[],
  settings: JourneySettings,
  terrain?: Terrain,
  vors?: Vor[],
  radioRoutes: RadioRouteChoice[] = []
): Segment {
  const limit = maxLegNm(settings)
  const first = planCorridor(from, to, airports, settings, corridorWidth(limit), terrain, vors, radioRoutes)
  const points = [from, ...first.stops, to]
  const stops: Stop[] = []
  const routes: (VorRoute | null)[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]]
    let part: Segment = { stops: [], routes: first.routes ? [first.routes[i]] : undefined }
    if (between(a, b) > limit + 0.5) {
      const wider = planCorridor(a, b, airports, settings, WIDE_CORRIDOR_NM, terrain, vors, radioRoutes)
      const longest = (s: Segment) => Math.max(...[a, ...s.stops, b].slice(1).map((p, k) => between([a, ...s.stops][k], p)))
      if (wider.stops.length > 0 && longest(wider) < between(a, b)) part = wider
    }
    stops.push(...part.stops, ...(i < points.length - 2 ? [b] : []))
    if (part.routes) routes.push(...part.routes)
  }
  return first.routes ? { stops, routes } : { stops }
}

function planCorridor(
  from: Stop,
  to: Stop,
  airports: Airport[],
  settings: JourneySettings,
  width: number,
  terrain?: Terrain,
  vors?: Vor[],
  radioRoutes: RadioRouteChoice[] = []
): Segment {
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
  // Terminal NDBs are compass locators for approaches, too weak to navigate between.
  const stations =
    limits.vorRoutes && vors ? vorsNear(from, to, vors.filter((v) => (isNdb(v) ? limits.useNdbs && v.serviceClass !== 'T' : true)), width + limits.maxRadioGapNm) : []
  const routerFor = (searchNm: number) =>
    new VorRouter(stations, {
      altitudeFt: limits.maxAltitudeFt,
      maxGapNm: limits.maxRadioGapNm,
      searchNm,
      segmentOk: (a, b) => !checksTerrain || !breaksLimits(a, b),
      keyOf: stopKey
    })
  const router = limits.vorRoutes && vors ? routerFor(limit) : null
  const ownRoute = router && vors ? radioRoutes.find((c) => c.from === from.ident && c.to === to.ident) : undefined
  if (ownRoute) return { stops: [], routes: [chosenRoute(from, to, ownRoute, vors!, limits.maxAltitudeFt)] }
  // Further out, only for drawing a route to a stop the player chose that's past the longest leg.
  let further: VorRouter | null = null
  // A leg the player gave their own radio route to keeps it.
  const legRoute = (a: Stop, b: Stop) => {
    const choice = radioRoutes.find((c) => c.from === a.ident && c.to === b.ident)
    return choice && vors ? chosenRoute(a, b, choice, vors, limits.maxAltitudeFt) : router!.route(a, b)
  }
  const routeFor = (a: Stop, b: Stop) => router && (legRoute(a, b) ?? (further ??= routerFor(limit * 1.5)).route(a, b))
  const withRoutes = (stops: Stop[]): Segment =>
    router ? { stops, routes: [from, ...stops].map((stop, i) => routeFor(stop, [...stops, to][i])) } : { stops }

  if (router) {
    const direct = legRoute(from, to)
    if (direct && direct.distanceNm <= limit) return { stops: [], routes: [direct] }
  } else if (total <= limit && (!checksTerrain || !breaksLimits(from, to))) return { stops: [] }

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
      if (router) {
        // A radio route is never shorter than the straight line, so most hops are ruled out before routing.
        // A leg with no radio route costs far more than an extra stop, but is still planned like any other,
        // so where there are no VORs the plan falls back to sensible direct legs.
        const legCost = (nm: number) => {
          let edge = nm <= limit ? 1 + 0.3 * (1 - nm / limit) ** 2 + nodes[i].quality * 0.2 : GAP_COST + nm
          if (limits.minLegNm !== null && nm < limits.minLegNm && !(j === 0 && i === last)) edge += 0.5 + 2 * (1 - nm / limits.minLegNm)
          return edge
        }
        let edge = 2 * GAP_COST + legCost(d)
        if (d <= limit && cost[j] + 1 + nodes[i].quality * 0.2 < cost[i]) {
          const routed = legRoute(nodes[j].stop, nodes[i].stop)
          if (routed && routed.distanceNm <= limit) edge = legCost(routed.distanceNm)
        }
        if (cost[j] + edge < cost[i]) {
          cost[i] = cost[j] + edge
          previous[i] = j
        }
        continue
      }
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
  return withRoutes(stops)
}

/** Terrain and water along every stretch of a radio route, taken together. */
function routeConditions(from: Stop, to: Stop, route: VorRoute, settings: JourneySettings, terrain: Terrain | undefined) {
  const points: Stop[] = [from, ...route.fixes.map((f) => ({ ident: f.ident, name: f.name, lat: f.lat, lon: f.lon })), to]
  const parts = points.slice(1).map((point, i) => legConditions(points[i], point, settings, terrain))
  const most = (values: (number | null)[]) => (values.some((v) => v === null) ? null : Math.max(...(values as number[])))
  return {
    highestTerrainFt: most(parts.map((p) => p.highestTerrainFt)),
    longestWaterNm: most(parts.map((p) => p.longestWaterNm)),
    aboveCeiling: parts.some((p) => p.aboveCeiling),
    overWater: parts.some((p) => p.overWater)
  }
}

function buildLeg(
  from: Stop,
  to: Stop,
  settings: JourneySettings,
  terrain: Terrain | undefined,
  pinned: boolean,
  index: number,
  route?: VorRoute | null
): Leg {
  const { performance, maxLegMinutes, limits } = settings
  const distance = route ? route.distanceNm : distanceNm(from.lat, from.lon, to.lat, to.lon)
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
    ...(route ? routeConditions(from, to, route, settings, terrain) : legConditions(from, to, settings, terrain)),
    ...(route !== undefined && { vorRoute: route ? route.fixes : null }),
    ...(route?.chosen && { vorRouteChosen: true }),
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
export function reflow(journey: Journey, airports: Airport[], terrain?: Terrain, vors?: Vor[]): Journey {
  const flown = journey.legs.filter((leg) => leg.status === 'flown')
  const start = currentStop(journey)
  if (start.ident === journey.destination.ident) return { ...journey, legs: flown, status: 'complete', via: [] }

  const settings = settingsOf(journey)
  const choices = airports.filter((airport) => !journey.avoid.includes(airport.ident))
  const targets = [...journey.via, journey.destination]
  const planned: Leg[] = []
  let from = start
  for (const target of targets) {
    const segment = planSegment(from, target, choices, settings, terrain, vors, journey.radioRoutes)
    const stops = [...segment.stops, target]
    stops.forEach((stop, i) => {
      planned.push(buildLeg(from, stop, settings, terrain, stop === target, planned.length, segment.routes?.[i]))
      from = stop
    })
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
  notNegative(limits.maxRadioGapNm, 'Longest gap out of reception')
  if (limits.minLegNm !== null && limits.minLegNm >= maxLegNm(settings)) {
    throw new Error('Shortest leg needs to be less than the longest leg this aircraft can fly.')
  }
  return settings
}

export function createJourney(input: CreateJourneyInput, index: AirportIndex, id: string, now: number, terrain?: Terrain, vors?: Vor[]): Journey {
  const origin = toStop(requireAirport(index, input.originIdent))
  const destination = toStop(requireAirport(index, input.destinationIdent))
  const settings = checkSettings({
    performance: input.performance,
    maxLegMinutes: input.maxLegMinutes,
    limits: input.limits ?? NO_LIMITS
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
    terrain,
    vors
  )
}

/** Changes the aircraft numbers or route limits, and re-plans what hasn't been flown. */
export function updateSettings(journey: Journey, settings: JourneySettings, airports: Airport[], terrain?: Terrain, vors?: Vor[]): Journey {
  return reflow({ ...journey, ...checkSettings(settings) }, airports, terrain, vors)
}

type Point = Pick<Stop, 'lat' | 'lon'>
const between = (a: Point, b: Point) => distanceNm(a.lat, a.lon, b.lat, b.lon)

/** Adds a chosen stop where it costs the least extra distance, keeping the player's order. */
export function addVia(journey: Journey, stop: Stop, airports: Airport[], terrain?: Terrain, vors?: Vor[]): Journey {
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
  return reflow({ ...journey, via, avoid: journey.avoid.filter((ident) => ident !== stop.ident) }, airports, terrain, vors)
}

/** Takes a stop off the route, and keeps the planner from choosing it again. */
export function removeVia(journey: Journey, ident: string, airports: Airport[], terrain?: Terrain, vors?: Vor[]): Journey {
  const via = journey.via.filter((v) => v.ident !== ident)
  return reflow({ ...journey, via, avoid: [...new Set([...journey.avoid, ident])] }, airports, terrain, vors)
}

function replaceStop(journey: Journey, ident: string, stop: Stop, airports: Airport[], terrain?: Terrain, vors?: Vor[]): Journey {
  const isOtherChoice = (s: Stop) => s.ident !== stop.ident && journey.via.some((v) => v.ident === s.ident)
  const via = journey.legs
    .filter((leg) => leg.status === 'planned')
    .flatMap((leg) => (leg.to.ident === ident ? [stop] : isOtherChoice(leg.to) ? [leg.to] : []))
  const avoid = [...new Set([...journey.avoid.filter((a) => a !== stop.ident), ident])]
  return reflow({ ...journey, via, avoid }, airports, terrain, vors)
}

function moveStop(journey: Journey, ident: string, offset: -1 | 1, airports: Airport[], terrain?: Terrain, vors?: Vor[]): Journey {
  const from = journey.via.findIndex((v) => v.ident === ident)
  const to = from + offset
  if (from < 0 || to < 0 || to >= journey.via.length) return journey
  const via = [...journey.via]
  ;[via[from], via[to]] = [via[to], via[from]]
  return reflow({ ...journey, via }, airports, terrain, vors)
}

/**
 * Moves one stop to a different airport. Every stop before it is kept exactly where it is.
 * After it, 'keep' keeps every stop, and 'replan' plans everything from the new stop onwards afresh.
 */
function dragStop(journey: Journey, ident: string, stop: Stop, rest: 'keep' | 'replan', airports: Airport[], terrain?: Terrain, vors?: Vor[]): Journey {
  const ahead = journey.legs.filter((leg) => leg.status === 'planned').map((leg) => leg.to)
  const at = ahead.findIndex((s) => s.ident === ident)
  if (at < 0 || ident === journey.destination.ident) throw new Error(`${ident} isn't a stop you still have to fly to.`)
  if (ahead.some((s, i) => i !== at && s.ident === stop.ident)) throw new Error(`${stop.ident} is already on your route.`)

  const later = rest === 'keep' ? ahead.slice(at + 1, -1) : []
  const via = [...ahead.slice(0, at), stop, ...later]
  const avoid = [...new Set([...journey.avoid.filter((a) => a !== stop.ident), ident])]
  return reflow({ ...journey, via, avoid }, airports, terrain, vors)
}

function withEndpoints(journey: Journey, origin: Stop, destination: Stop, airports: Airport[], terrain?: Terrain, vors?: Vor[]): Journey {
  const name = journey.name === `${journey.origin.ident} to ${journey.destination.ident}` ? `${origin.ident} to ${destination.ident}` : journey.name
  const via = journey.via.filter((v) => v.ident !== origin.ident && v.ident !== destination.ident)
  return reflow({ ...journey, name, origin, destination, via }, airports, terrain, vors)
}

function requireNewStop(journey: Journey, stop: Stop): void {
  if (stop.ident === journey.destination.ident) throw new Error(`${stop.ident} is already your destination.`)
  if (stop.ident === currentStop(journey).ident) throw new Error(`You're already at ${stop.ident}.`)
}

/** How far from a leg a station named by the player is looked for. */
const ADD_STATION_WITHIN_NM = 300

const refOf = ({ ident, lat, lon }: StationRef): StationRef => ({ ident, lat, lon })

/** Sets, or with null clears, the player's own radio route for one leg. */
/**
 * Sets, or with null clears, the player's own radio route for one leg. Only one leg leaves any airport,
 * so a route chosen earlier from the same departure, to a stop no longer planned, is dropped.
 */
function withRadioRoute(journey: Journey, from: string, to: string, stations: StationRef[] | null): Journey {
  const others = (journey.radioRoutes ?? []).filter((c) => c.from !== from)
  return { ...journey, radioRoutes: stations ? [...others, { from, to, stations }] : others }
}

/**
 * Makes a leg's arrival one of the player's stops, so the leg they just changed the route of stays as it
 * is when the Journey re-plans. Otherwise a new route can tip the planner to another stop, and that leg
 * would get a fresh suggestion.
 */
function keepStop(journey: Journey, stop: Stop): Journey {
  if (stop.ident === journey.destination.ident || journey.via.some((v) => v.ident === stop.ident)) return journey
  const ahead = journey.legs.filter((leg) => leg.status === 'planned').map((leg) => leg.to)
  const via = ahead.filter((s) => s.ident === stop.ident || journey.via.some((v) => v.ident === s.ident))
  return { ...journey, via, avoid: journey.avoid.filter((ident) => ident !== stop.ident) }
}

function editRadioRoute(journey: Journey, edit: Extract<RouteEdit, { kind: 'radio-skip' | 'radio-add' | 'radio-reset' }>, vors: Vor[]): Journey {
  if (edit.kind === 'radio-reset') return withRadioRoute(journey, edit.from, edit.to, null)
  const leg = journey.legs.find((l) => l.status === 'planned' && l.from.ident === edit.from && l.to.ident === edit.to)
  if (!leg) throw new Error(`${edit.from} to ${edit.to} isn't a leg you still have to fly.`)
  const current = (leg.vorRoute ?? []).map(refOf)

  if (edit.kind === 'radio-skip') return keepStop(withRadioRoute(journey, edit.from, edit.to, current.filter((_, i) => i !== edit.index)), leg.to)

  const ident = edit.ident.trim().toUpperCase()
  const middle = { lat: (leg.from.lat + leg.to.lat) / 2, lon: (leg.from.lon + leg.to.lon) / 2 }
  const allowed = vors.filter((v) => v.ident === ident && (journey.limits.useNdbs || !isNdb(v)))
  const station = allowed
    .map((v) => ({ v, nm: between(middle, v) }))
    .filter((c) => c.nm <= ADD_STATION_WITHIN_NM + between(leg.from, leg.to) / 2)
    .sort((a, b) => a.nm - b.nm)[0]?.v
  if (!station) {
    const ndbOnly = vors.some((v) => v.ident === ident && isNdb(v)) && !journey.limits.useNdbs
    throw new Error(ndbOnly ? `${ident} is an NDB. Turn on "Use NDBs too" to add it.` : `Couldn't find a station called ${ident} near this leg.`)
  }
  if (current.some((ref) => sameStation(station, ref))) throw new Error(`${ident} is already on this leg's route.`)
  // Where it adds the least distance, keeping the stations already chosen in order.
  const points: StationRef[] = [leg.from, ...current, leg.to]
  let at = 0
  let least = Infinity
  for (let i = 0; i < points.length - 1; i++) {
    const added = between(points[i], station) + between(station, points[i + 1]) - between(points[i], points[i + 1])
    if (added < least) {
      least = added
      at = i
    }
  }
  const stations = [...current]
  stations.splice(at, 0, refOf(station))
  return keepStop(withRadioRoute(journey, edit.from, edit.to, stations), leg.to)
}

/** Applies one change the player made to the part of the route they haven't flown. */
export function editRoute(journey: Journey, edit: RouteEdit, index: AirportIndex, terrain?: Terrain, vors?: Vor[]): Journey {
  const airports = index.all
  if (edit.kind === 'radio-skip' || edit.kind === 'radio-add' || edit.kind === 'radio-reset') {
    return reflow(editRadioRoute(journey, edit, vors ?? []), airports, terrain, vors)
  }
  if (edit.kind === 'reset') return reflow({ ...journey, via: [], avoid: [] }, airports, terrain, vors)
  if (edit.kind === 'remove') return removeVia(journey, edit.ident, airports, terrain, vors)
  if (edit.kind === 'move') return moveStop(journey, edit.ident, edit.offset, airports, terrain, vors)

  const stop = toStop(requireAirport(index, edit.kind === 'replace' || edit.kind === 'drag' ? edit.withIdent : edit.ident))
  switch (edit.kind) {
    case 'add':
      requireNewStop(journey, stop)
      return addVia(journey, stop, airports, terrain, vors)
    case 'replace':
      requireNewStop(journey, stop)
      return replaceStop(journey, edit.ident, stop, airports, terrain, vors)
    case 'drag':
      requireNewStop(journey, stop)
      return dragStop(journey, edit.ident, stop, edit.rest, airports, terrain, vors)
    case 'origin':
      if (journey.legs.some((leg) => leg.status === 'flown')) throw new Error('You have already left the first airport.')
      if (stop.ident === journey.destination.ident) throw new Error(`${stop.ident} is already your destination.`)
      return withEndpoints(journey, stop, journey.destination, airports, terrain, vors)
    case 'destination':
      if (stop.ident === currentStop(journey).ident) throw new Error(`You're already at ${stop.ident}.`)
      return withEndpoints(journey, journey.origin, stop, airports, terrain, vors)
  }
}

/** Records a finished flight on the Journey, and re-plans from wherever it ended. */
export function applyFlight(journey: Journey, flight: LogbookFlight, index: AirportIndex, terrain?: Terrain, vors?: Vor[]): Journey | null {
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
  return reflow({ ...journey, legs, via }, index.all, terrain, vors)
}

/**
 * Takes a deleted logbook flight off the Journey. The latest flown leg is undone and the rest re-planned from where
 * it started; an earlier one stays on the route, since later legs set off from where it ended, but no longer points
 * at the flight. null when the flight wasn't a leg of this Journey.
 */
export function withoutFlight(journey: Journey, flightId: string, airports: Airport[], terrain?: Terrain, vors?: Vor[]): Journey | null {
  const index = journey.legs.findIndex((leg) => leg.flightId === flightId)
  if (index < 0) return null
  const lastFlown = journey.legs.findLastIndex((leg) => leg.status === 'flown')
  if (index !== lastFlown) return { ...journey, legs: journey.legs.map((leg, i) => (i === index ? { ...leg, flightId: null } : leg)) }
  const legs = journey.legs.filter((leg) => leg.status === 'flown' && leg.flightId !== flightId)
  return reflow({ ...journey, legs }, airports, terrain, vors)
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
