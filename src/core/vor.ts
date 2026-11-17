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

/**
 * How far out a VOR can be relied on when flying VFR, from the FAA's low-altitude service volumes:
 * 25 nm for terminal stations and 40 nm for the rest. Below 14,500 ft even a high-altitude station is
 * only promised 40 nm, and VFR stays below 18,000 ft, so the larger high-altitude ranges are never used.
 */
export const receptionNm = (vor: Pick<Vor, 'serviceClass'>): number => (vor.serviceClass === 'T' ? 25 : 40)

export const toFix = (vor: Vor): VorFix => ({
  ident: vor.ident,
  name: vor.name,
  type: vor.type,
  freqMhz: vor.freqKhz / 1000,
  lat: vor.lat,
  lon: vor.lon,
  magVarDeg: vor.magVarDeg
})

export interface VorRoute {
  fixes: VorFix[]
  /** Along the route, from the departure through each VOR to the arrival. */
  distanceNm: number
}

interface Station {
  vor: Vor
  /** The station as a point, named uniquely so limit checks can be remembered for it. */
  point: Stop
  rangeNm: number
}

interface Tree {
  distance: Float64Array
  previous: Int32Array
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
 * Finds the shortest chain of VORs between two points. Every stretch is flown within reception of a
 * station: out from the departure to the first VOR, between neighbouring VORs (each tuned for its half),
 * and from the last VOR to the arrival. Stretches that break the player's limits aren't used.
 */
export class VorRouter {
  private readonly stations: Station[]
  private readonly neighbours: ({ to: number; nm: number }[] | undefined)[]
  private readonly trees = new Map<string, Tree>()
  private readonly exits = new Map<string, { at: number; nm: number }[]>()

  constructor(
    vors: Vor[],
    /** Routes longer than this aren't looked for. */
    private readonly searchNm: number,
    private readonly segmentOk: (a: Stop, b: Stop) => boolean,
    private readonly keyOf: (stop: Stop) => string
  ) {
    this.stations = vors.map((vor) => ({
      vor,
      point: { ident: `VOR ${vor.ident} ${vor.lat},${vor.lon}`, name: vor.name, lat: vor.lat, lon: vor.lon },
      rangeNm: receptionNm(vor)
    }))
    this.neighbours = new Array(this.stations.length)
  }

  private linksFrom(at: number) {
    const known = this.neighbours[at]
    if (known) return known
    const here = this.stations[at]
    const links: { to: number; nm: number }[] = []
    this.stations.forEach((there, to) => {
      if (to === at) return
      const nm = distanceNm(here.vor.lat, here.vor.lon, there.vor.lat, there.vor.lon)
      if (nm <= here.rangeNm + there.rangeNm && this.segmentOk(here.point, there.point)) links.push({ to, nm })
    })
    return (this.neighbours[at] = links)
  }

  /** Shortest distances from a point to every station it can reach, through other stations. */
  private treeFrom(start: Stop): Tree {
    const key = this.keyOf(start)
    const known = this.trees.get(key)
    if (known) return known
    const distance = new Float64Array(this.stations.length).fill(Infinity)
    const previous = new Int32Array(this.stations.length).fill(-1)
    const queue = new Queue()
    this.stations.forEach((station, at) => {
      const nm = distanceNm(start.lat, start.lon, station.vor.lat, station.vor.lon)
      if (nm <= station.rangeNm && nm <= this.searchNm && this.segmentOk(start, station.point)) {
        distance[at] = nm
        queue.push(at, nm)
      }
    })
    while (queue.size > 0) {
      const [at, nm] = queue.pop()
      if (nm > distance[at]) continue
      for (const link of this.linksFrom(at)) {
        const through = nm + link.nm
        if (through < distance[link.to] && through <= this.searchNm) {
          distance[link.to] = through
          previous[link.to] = at
          queue.push(link.to, through)
        }
      }
    }
    const tree = { distance, previous }
    this.trees.set(key, tree)
    return tree
  }

  /** Stations the arrival can be flown to from. */
  private exitsTo(end: Stop) {
    const key = this.keyOf(end)
    const known = this.exits.get(key)
    if (known) return known
    const exits: { at: number; nm: number }[] = []
    this.stations.forEach((station, at) => {
      const nm = distanceNm(station.vor.lat, station.vor.lon, end.lat, end.lon)
      if (nm <= station.rangeNm && this.segmentOk(station.point, end)) exits.push({ at, nm })
    })
    this.exits.set(key, exits)
    return exits
  }

  /** The shortest radio route, or null if there isn't one within the search distance and limits. */
  route(from: Stop, to: Stop): VorRoute | null {
    const tree = this.treeFrom(from)
    let best: { at: number; nm: number } | null = null
    for (const exit of this.exitsTo(to)) {
      const nm = tree.distance[exit.at] + exit.nm
      if (nm <= this.searchNm && (!best || nm < best.nm)) best = { at: exit.at, nm }
    }
    if (!best) return null
    const fixes: VorFix[] = []
    for (let at = best.at; at >= 0; at = tree.previous[at]) fixes.unshift(toFix(this.stations[at].vor))
    return { fixes, distanceNm: best.nm }
  }
}
