import type { Stop, Vor, VorClass, VorFix } from '../shared/journey'
import { distanceNm } from './recorder'

/** One row of resources/navaids.json, built by scripts/build-navaids.mjs. */
export type VorRow = [string, string, Vor['type'], number, number, number, number, VorClass, string, number?]

export const vorsFromRows = (rows: VorRow[]): Vor[] =>
  rows.map(([ident, name, type, freqKhz, lat, lon, elevationFt, serviceClass, country, magVarDeg = 0]) => ({
    ident,
    name,
    type,
    freqKhz,
    lat,
    lon,
    elevationFt,
    serviceClass,
    country,
    magVarDeg
  }))

/** The altitude reception is worked out for when the player hasn't set the highest they'll fly. */
export const ASSUMED_ALTITUDE_FT = 6500
/**
 * With no highest altitude set, the player is assumed to be at least this far above any station, since
 * nobody cruises a few hundred feet over a VOR on a high plateau.
 */
const ASSUMED_ABOVE_STATION_FT = 3000
/** How far each class of station is rated to reach: VORs as published, NDBs by the FAA's classes. */
const VOR_RANGE_NM: Record<VorClass, number> = { T: 25, L: 40, H: 130 }
const NDB_RANGE_NM: Record<VorClass, number> = { T: 15, L: 25, H: 50 }

export const isNdb = (navaid: Pick<Vor, 'type'>) => navaid.type === 'NDB' || navaid.type === 'NDB-DME'

/**
 * How far out a station can be counted on at the altitude flown. A VOR is line of sight, so it's its
 * rated range but never past the radio horizon (about 1.23 × √feet above the station). An NDB's signal
 * follows the ground, so it's just its rated range.
 */
export function receptionNm(navaid: Pick<Vor, 'type' | 'serviceClass' | 'elevationFt'>, altitudeFt: number | null): number {
  if (isNdb(navaid)) return NDB_RANGE_NM[navaid.serviceClass]
  const above =
    altitudeFt === null
      ? Math.max(ASSUMED_ABOVE_STATION_FT, ASSUMED_ALTITUDE_FT - navaid.elevationFt)
      : Math.max(500, altitudeFt - navaid.elevationFt)
  return Math.min(VOR_RANGE_NM[navaid.serviceClass], 1.23 * Math.sqrt(above))
}

export const toFix = (vor: Vor, rangeNm: number): VorFix => ({
  ident: vor.ident,
  name: vor.name,
  type: vor.type,
  freqMhz: vor.freqKhz / 1000,
  lat: vor.lat,
  lon: vor.lon,
  magVarDeg: vor.magVarDeg,
  rangeNm: Math.round(rangeNm)
})

export interface VorRoute {
  fixes: VorFix[]
  /** Along the route, from the departure through each station to the arrival. */
  distanceNm: number
  /** The player's own route rather than a suggestion. */
  chosen?: boolean
}

interface Station {
  vor: Vor
  /** The station as a point, named uniquely so limit checks can be remembered for it. */
  point: Stop
  rangeNm: number
}

interface Link {
  to: number
  nm: number
  cost: number
}

interface Tree {
  cost: Float64Array
  distance: Float64Array
  previous: Int32Array
}

/** A stretch flown out of reception, on heading, counts this much extra against it per mile. */
const GAP_WEIGHT = 1.5
/** NDBs are less precise to track than VORs, so a stretch to one counts a little extra. */
const NDB_WEIGHT = 0.15

export interface RouterOptions {
  /** The highest the player will fly, which sets how far VORs reach. null: the assumed altitude. */
  altitudeFt: number | null
  /** The longest stretch flown out of reception of any station, on heading, between two stations. */
  maxGapNm: number
  /** Routes longer than this aren't looked for. */
  searchNm: number
  segmentOk: (a: Stop, b: Stop) => boolean
  keyOf: (stop: Stop) => string
}

/** The smallest-first queue Dijkstra needs. */
class Queue {
  private items: [number, number][] = []
  get size() {
    return this.items.length
  }
  push(item: number, priority: number) {
    const items = this.items
    items.push([item, priority])
    for (let i = items.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1
      if (items[parent][1] <= items[i][1]) break
      ;[items[parent], items[i]] = [items[i], items[parent]]
      i = parent
    }
  }
  pop(): [number, number] {
    const items = this.items
    const top = items[0]
    const last = items.pop()!
    if (items.length > 0) {
      items[0] = last
      for (let i = 0; ; ) {
        const left = 2 * i + 1
        const right = left + 1
        let smallest = i
        if (left < items.length && items[left][1] < items[smallest][1]) smallest = left
        if (right < items.length && items[right][1] < items[smallest][1]) smallest = right
        if (smallest === i) break
        ;[items[smallest], items[i]] = [items[i], items[smallest]]
        i = smallest
      }
    }
    return top
  }
}

/**
 * Finds a good chain of radio stations between two points: the shortest, preferring stretches flown in
 * reception all the way, and VORs over NDBs. As when flying VFR for real, a stretch can leave one station's
 * range and carry on on heading until the next comes in, as long as that gap stays within the limit.
 * Stretches that break the player's terrain and water limits aren't used.
 */
export class VorRouter {
  private readonly stations: Station[]
  private readonly neighbours: (Link[] | undefined)[]
  private readonly trees = new Map<string, Tree>()
  private readonly exits = new Map<string, { at: number; nm: number; cost: number }[]>()

  constructor(
    navaids: Vor[],
    private readonly options: RouterOptions
  ) {
    // Sorted south to north, so only stations in a band of latitude need checking for each one.
    this.stations = navaids
      .map((vor) => ({
        vor,
        point: { ident: `NAV ${vor.ident} ${vor.lat},${vor.lon}`, name: vor.name, lat: vor.lat, lon: vor.lon },
        rangeNm: receptionNm(vor, options.altitudeFt)
      }))
      .sort((a, b) => a.vor.lat - b.vor.lat)
    this.neighbours = new Array(this.stations.length)
    this.reachNm = Math.max(0, ...this.stations.map((s) => s.rangeNm)) + options.maxGapNm
  }

  /** The furthest any station can be from a point and still be part of a stretch from it. */
  private readonly reachNm: number

  /** Calls back with each station within `nm` of a latitude's band, and its index. */
  private near(lat: number, nm: number, visit: (station: Station, at: number) => void) {
    const deg = nm / 60
    let low = 0
    let high = this.stations.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (this.stations[mid].vor.lat < lat - deg) low = mid + 1
      else high = mid
    }
    for (let at = low; at < this.stations.length && this.stations[at].vor.lat <= lat + deg; at++) visit(this.stations[at], at)
  }

  /** What a stretch counts as, or null if its gap out of reception is too long. */
  private stretchCost(nm: number, coveredNm: number, toNdb: boolean): number | null {
    const gap = Math.max(0, nm - coveredNm)
    if (gap > this.options.maxGapNm) return null
    return nm + gap * GAP_WEIGHT + (toNdb ? nm * NDB_WEIGHT : 0)
  }

  private linksFrom(at: number): Link[] {
    const known = this.neighbours[at]
    if (known) return known
    const here = this.stations[at]
    const links: Link[] = []
    this.near(here.vor.lat, here.rangeNm + this.reachNm, (there, to) => {
      if (to === at) return
      const nm = distanceNm(here.vor.lat, here.vor.lon, there.vor.lat, there.vor.lon)
      const cost = this.stretchCost(nm, here.rangeNm + there.rangeNm, isNdb(there.vor))
      if (cost !== null && this.options.segmentOk(here.point, there.point)) links.push({ to, nm, cost })
    })
    return (this.neighbours[at] = links)
  }

  /** The best way from a point to every station it can reach, through other stations. */
  private treeFrom(start: Stop): Tree {
    const key = this.options.keyOf(start)
    const known = this.trees.get(key)
    if (known) return known
    const size = this.stations.length
    const cost = new Float64Array(size).fill(Infinity)
    const distance = new Float64Array(size).fill(Infinity)
    const previous = new Int32Array(size).fill(-1)
    const queue = new Queue()
    this.near(start.lat, this.reachNm, (station, at) => {
      const nm = distanceNm(start.lat, start.lon, station.vor.lat, station.vor.lon)
      if (nm > this.options.searchNm) return
      const c = this.stretchCost(nm, station.rangeNm, isNdb(station.vor))
      if (c !== null && this.options.segmentOk(start, station.point)) {
        cost[at] = c
        distance[at] = nm
        queue.push(at, c)
      }
    })
    while (queue.size > 0) {
      const [at, c] = queue.pop()
      if (c > cost[at]) continue
      for (const link of this.linksFrom(at)) {
        const through = c + link.cost
        const nm = distance[at] + link.nm
        if (through < cost[link.to] && nm <= this.options.searchNm) {
          cost[link.to] = through
          distance[link.to] = nm
          previous[link.to] = at
          queue.push(link.to, through)
        }
      }
    }
    const tree = { cost, distance, previous }
    this.trees.set(key, tree)
    return tree
  }

  /** Stations the arrival can be flown to from. */
  private exitsTo(end: Stop) {
    const key = this.options.keyOf(end)
    const known = this.exits.get(key)
    if (known) return known
    const exits: { at: number; nm: number; cost: number }[] = []
    this.near(end.lat, this.reachNm, (station, at) => {
      const nm = distanceNm(station.vor.lat, station.vor.lon, end.lat, end.lon)
      const cost = this.stretchCost(nm, station.rangeNm, false)
      if (cost !== null && this.options.segmentOk(station.point, end)) exits.push({ at, nm, cost })
    })
    this.exits.set(key, exits)
    return exits
  }

  /** The best radio route, or null if there isn't one within the search distance, gap and limits. */
  route(from: Stop, to: Stop): VorRoute | null {
    const tree = this.treeFrom(from)
    let best: { at: number; nm: number; cost: number } | null = null
    for (const exit of this.exitsTo(to)) {
      const nm = tree.distance[exit.at] + exit.nm
      const cost = tree.cost[exit.at] + exit.cost
      if (nm <= this.options.searchNm && (!best || cost < best.cost)) best = { at: exit.at, nm, cost }
    }
    if (!best) return null
    const fixes: VorFix[] = []
    for (let at = best.at; at >= 0; at = tree.previous[at]) fixes.unshift(toFix(this.stations[at].vor, this.stations[at].rangeNm))
    return { fixes, distanceNm: best.nm }
  }
}
