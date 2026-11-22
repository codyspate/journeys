import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { NO_LIMITS, PERFORMANCE_PRESETS, type RouteLimits, type Stop, type Vor } from '../shared/journey'
import { AirportIndex, airportsFromRows, type AirportRow } from './airports'
import { createJourney, editRoute, maxLegNm, settingsOf, updateSettings } from './planner'
import { distanceNm } from './recorder'
import { TerrainGrid } from './terrain'
import { receptionNm, type VorRow, VorRouter, vorsFromRows } from './vor'

const world = TerrainGrid.fromBytes(gunzipSync(readFileSync(join(process.cwd(), 'resources/terrain.bin.gz'))))
const index = new AirportIndex(airportsFromRows(JSON.parse(readFileSync('resources/airports.json', 'utf8')) as AirportRow[]))
const vors = vorsFromRows(JSON.parse(readFileSync('resources/navaids.json', 'utf8')) as VorRow[])

// On the equator one degree of longitude is 60 nm.
const point = (ident: string, lon: number): Stop => ({ ident, name: ident, lat: 0, lon })
const vor = (ident: string, lon: number, serviceClass: Vor['serviceClass'] = 'L', type: Vor['type'] = 'VOR'): Vor => ({
  ident,
  name: ident,
  type,
  freqKhz: type.startsWith('NDB') ? 373 : 113_000,
  lat: 0,
  lon,
  elevationFt: 0,
  serviceClass,
  country: 'XX',
  magVarDeg: 0
})
type Options = { segmentOk?: (a: Stop, b: Stop) => boolean; searchNm?: number; maxGapNm?: number; altitudeFt?: number }
const router = (stations: Vor[], { segmentOk = () => true, searchNm = 1000, maxGapNm = 0, altitudeFt = 6500 }: Options = {}) =>
  new VorRouter(stations, { altitudeFt, maxGapNm, searchNm, segmentOk, keyOf: (stop: Stop) => `${stop.ident}@${stop.lat},${stop.lon}` })

describe('receptionNm', () => {
  const at = (serviceClass: Vor['serviceClass'], type: Vor['type'] = 'VOR', elevationFt = 0) => ({ serviceClass, type, elevationFt })

  it('uses the rated range of terminal and low VORs', () => {
    expect(receptionNm(at('T'), 6500)).toBe(25)
    expect(receptionNm(at('L'), 6500)).toBe(40)
  })

  it('lets high VORs reach further the higher you fly, up to the radio horizon', () => {
    expect(receptionNm(at('H'), 3000)).toBeCloseTo(67, 0)
    expect(receptionNm(at('H'), 9500)).toBeCloseTo(120, 0)
    expect(receptionNm(at('H'), 17_500)).toBe(130)
    // From a station on a 5,000 ft mesa, 9,500 ft is only 4,500 ft above it.
    expect(receptionNm(at('H', 'VOR', 5000), 9500)).toBeCloseTo(83, 0)
    // Blank means the assumed 6,500 ft, but never less than 3,000 ft above a station on high ground.
    expect(receptionNm(at('H'), null)).toBeCloseTo(99, 0)
    expect(receptionNm(at('H', 'VOR', 6112), null)).toBeCloseTo(67, 0)
  })

  it('gives NDBs their rated range whatever the altitude', () => {
    expect(receptionNm(at('H', 'NDB'), 3000)).toBe(50)
    expect(receptionNm(at('L', 'NDB-DME'), 12_000)).toBe(25)
    expect(receptionNm(at('T', 'NDB'), 12_000)).toBe(15)
  })
})

describe('VorRouter', () => {
  // Low VORs reach 40 nm, so neighbours up to 80 nm apart are covered all the way.
  const chain = [vor('V1', 0.5), vor('V2', 1.75), vor('V3', 3), vor('V4', 4.25)]

  it('chains stations from departure to arrival, keeping how far each was counted on', () => {
    const route = router(chain).route(point('A', 0), point('B', 4.75))
    expect(route?.fixes.map((f) => f.ident)).toEqual(['V1', 'V2', 'V3', 'V4'])
    expect(route?.distanceNm).toBeCloseTo(285, 0)
    expect(route?.fixes[0]).toMatchObject({ freqMhz: 113, rangeNm: 40 })
  })

  it('finds nothing across a gap too wide to receive, with no gaps allowed', () => {
    const gappy = [vor('V1', 0.5), vor('V4', 4.25)]
    expect(router(gappy).route(point('A', 0), point('B', 4.75))).toBeNull()
  })

  it('flies on heading across a gap when gaps are allowed', () => {
    // V1 and V4 are 225 nm apart with 80 nm covered: a 145 nm gap.
    const gappy = [vor('V1', 0.5), vor('V2', 2), vor('V4', 3.25)]
    // V1 to V2 is 90 nm, a 10 nm gap; V2 to V4 is 75 nm, covered.
    expect(router(gappy).route(point('A', 0), point('B', 3.75))).toBeNull()
    expect(router(gappy, { maxGapNm: 15 }).route(point('A', 0), point('B', 3.75))?.fixes.map((f) => f.ident)).toEqual(['V1', 'V2', 'V4'])
  })

  it('prefers full coverage when it costs little extra, but takes a short gap over a long detour', () => {
    // Straight: V1 to V3 is 90 nm, a 10 nm gap. Covered: through N, slightly off the line.
    const covered = [vor('V1', 0.5), { ...vor('N', 1.25), lat: 0.2 }, vor('V3', 2)]
    expect(router(covered, { maxGapNm: 30 }).route(point('A', 0), point('B', 2.5))?.fixes.map((f) => f.ident)).toEqual(['V1', 'N', 'V3'])
    const detour = [vor('V1', 0.5), { ...vor('N', 1.25), lat: 1.2 }, vor('V3', 2)]
    expect(router(detour, { maxGapNm: 30 }).route(point('A', 0), point('B', 2.5))?.fixes.map((f) => f.ident)).toEqual(['V1', 'V3'])
  })

  it('uses an NDB where there is no VOR, and a VOR when there is a choice', () => {
    // An NDB rated H reaches 50 nm, a low VOR 40.
    const withNdb = [vor('V1', 0.5), vor('N1', 1.9, 'H', 'NDB'), vor('V3', 3.3)]
    expect(router(withNdb).route(point('A', 0), point('B', 3.8))?.fixes.map((f) => f.ident)).toEqual(['V1', 'N1', 'V3'])
    // A high VOR beside the NDB reaches far enough to link, and wins.
    const both = [...withNdb, { ...vor('V2', 1.9, 'H'), lat: 0.01 }]
    expect(router(both).route(point('A', 0), point('B', 3.8))?.fixes.map((f) => f.ident)).toEqual(['V1', 'V2', 'V3'])
  })

  it('goes around a stretch that breaks the limits', () => {
    const detour = [...chain, { ...vor('N', 2.4), lat: 0.4 }]
    const blocked = (a: Stop, b: Stop) => !(a.name === 'V2' && b.name === 'V3')
    const route = router(detour, { segmentOk: blocked }).route(point('A', 0), point('B', 4.75))
    expect(route?.fixes.map((f) => f.ident)).toEqual(['V1', 'V2', 'N', 'V3', 'V4'])
  })

  it('does not look past the search distance', () => {
    expect(router(chain, { searchNm: 200 }).route(point('A', 0), point('B', 4.75))).toBeNull()
  })
})

describe('planning with radio navigation', () => {
  const plan = (from: string, to: string, limits: Partial<RouteLimits> = {}, vorRoutes = true) =>
    createJourney(
      {
        name: '',
        originIdent: from,
        destinationIdent: to,
        performance: PERFORMANCE_PRESETS[1],
        maxLegMinutes: 240,
        limits: { ...NO_LIMITS, ...limits, vorRoutes }
      },
      index,
      'j',
      0,
      world,
      vors
    )

  it('routes every leg through VORs where they are dense, within the longest leg', () => {
    const journey = plan('EGLL', 'LIRF')
    const limit = maxLegNm(settingsOf(journey))
    for (const leg of journey.legs) {
      expect(leg.vorRoute?.length).toBeGreaterThan(0)
      expect(leg.distanceNm).toBeLessThanOrEqual(limit)
      // The leg's distance is the routed one, through every station.
      const points = [leg.from, ...leg.vorRoute!, leg.to]
      const routed = points.slice(1).reduce((sum, p, i) => sum + distanceNm(points[i].lat, points[i].lon, p.lat, p.lon), 0)
      expect(leg.distanceNm).toBeCloseTo(routed, 3)
    }
  })

  it('routes most of the way across the US, falling back to direct only over the widest gaps', () => {
    const journey = plan('KSAN', 'KBOS')
    const routed = journey.legs.filter((leg) => leg.vorRoute)
    expect(routed.length).toBeGreaterThanOrEqual(journey.legs.length - 1)
    for (const leg of routed) expect(leg.distanceNm).toBeLessThanOrEqual(maxLegNm(settingsOf(journey)))
  })

  it('keeps every stretch under the highest altitude where it can', () => {
    const journey = plan('KAPA', 'KSLC', { maxAltitudeFt: 12_500 })
    expect(journey.legs.every((leg) => leg.vorRoute && !leg.aboveCeiling)).toBe(true)
  })

  it('falls back to direct legs where VORs are too sparse, and never fails to plan', () => {
    const journey = plan('YSSY', 'YPPH')
    expect(journey.legs.at(-1)?.to.ident).toBe('YPPH')
    expect(journey.legs.some((leg) => leg.vorRoute === null)).toBe(true)
  })

  it('only uses NDBs when they are allowed, and never terminal ones', () => {
    const ndbs = (journey: ReturnType<typeof plan>) => journey.legs.flatMap((leg) => leg.vorRoute ?? []).filter((f) => f.type.startsWith('NDB'))
    const routed = (journey: ReturnType<typeof plan>) => journey.legs.filter((leg) => leg.vorRoute).length
    const off = plan('KSEA', 'PANC')
    const on = plan('KSEA', 'PANC', { useNdbs: true })
    expect(ndbs(off)).toEqual([])
    expect(routed(on)).toBeGreaterThanOrEqual(routed(off))
    const terminal = new Set(vors.filter((v) => v.type.startsWith('NDB') && v.serviceClass === 'T').map((v) => `${v.ident}@${v.lat},${v.lon}`))
    expect(ndbs(on).some((f) => terminal.has(`${f.ident}@${f.lat},${f.lon}`))).toBe(false)
  })

  it('routes more of a sparse country when flying higher and allowing gaps', () => {
    const routed = (journey: ReturnType<typeof plan>) => journey.legs.filter((leg) => leg.vorRoute).length / journey.legs.length
    const strict = plan('YSSY', 'YPPH', { maxRadioGapNm: 0, maxAltitudeFt: 3000 })
    const relaxed = plan('YSSY', 'YPPH', { maxRadioGapNm: 30, maxAltitudeFt: 9500 })
    expect(routed(relaxed)).toBeGreaterThan(routed(strict))
  })

  it('crosses an ocean by island-hopping well off the direct line rather than flying a leg too long', () => {
    const journey = createJourney(
      {
        name: '',
        originIdent: 'MMLO',
        destinationIdent: 'EDGB',
        performance: PERFORMANCE_PRESETS[0],
        maxLegMinutes: 240,
        limits: { ...NO_LIMITS, vorRoutes: true }
      },
      index,
      'j',
      0,
      world,
      vors
    )
    const limit = maxLegNm(settingsOf(journey))
    for (const leg of journey.legs) expect(Math.round(leg.distanceNm)).toBeLessThanOrEqual(Math.ceil(limit))
    expect(journey.legs.some((leg) => leg.to.ident.startsWith('BG') || leg.to.ident.startsWith('BI'))).toBe(true)
  }, 120_000)

  describe("the player's own radio route", () => {
    const journey = plan('KSAN', 'KBOS')
    const first = journey.legs[0]
    const pair = { from: first.from.ident, to: first.to.ident }
    const idents = (j: typeof journey) => j.legs[0].vorRoute?.map((f) => f.ident)
    const apply = (j: typeof journey, change: Parameters<typeof editRoute>[1]) => editRoute(j, change, index, world, vors)

    it('skips a station, and keeps the change through re-planning', () => {
      const skipped = apply(journey, { kind: 'radio-skip', ...pair, index: 0 })
      expect(idents(skipped)).toEqual(first.vorRoute!.slice(1).map((f) => f.ident))
      expect(skipped.legs[0].vorRouteChosen).toBe(true)
      const replanned = updateSettings(skipped, { ...settingsOf(skipped), maxLegMinutes: skipped.maxLegMinutes }, index.all, world, vors)
      expect(idents(replanned)).toEqual(idents(skipped))
    })

    it('adds a station by its ident where it adds the least distance, and goes back to the suggestion', () => {
      const skipped = apply(journey, { kind: 'radio-skip', ...pair, index: 0 })
      const back = apply(skipped, { kind: 'radio-add', ...pair, ident: first.vorRoute![0].ident.toLowerCase() })
      expect(idents(back)).toEqual(idents(journey))
      const reset = apply(skipped, { kind: 'radio-reset', ...pair })
      expect(idents(reset)).toEqual(idents(journey))
      expect(reset.legs[0].vorRouteChosen).toBeUndefined()
    })

    it('can be flown direct by skipping every station', () => {
      let direct = journey
      while (direct.legs[0].vorRoute!.length > 0) direct = apply(direct, { kind: 'radio-skip', ...pair, index: 0 })
      expect(direct.legs[0].vorRouteChosen).toBe(true)
      expect(direct.legs[0].distanceNm).toBeCloseTo(distanceNm(first.from.lat, first.from.lon, first.to.lat, first.to.lon), 3)
    })

    it('says why a station cannot be added', () => {
      expect(() => apply(journey, { kind: 'radio-add', ...pair, ident: 'ZZZZ' })).toThrow("Couldn't find a station called ZZZZ")
      expect(() => apply(journey, { kind: 'radio-add', ...pair, ident: first.vorRoute![0].ident })).toThrow('already on this leg')
    })
  })

  it('leaves legs without routes when it is off', () => {
    const journey = plan('KSAN', 'KBOS', {}, false)
    expect(journey.legs.every((leg) => leg.vorRoute === undefined)).toBe(true)
  })
})
