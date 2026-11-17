import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { NO_LIMITS, PERFORMANCE_PRESETS, type RouteLimits, type Stop, type Vor } from '../shared/journey'
import { AirportIndex, airportsFromRows, type AirportRow } from './airports'
import { createJourney, maxLegNm, settingsOf } from './planner'
import { distanceNm } from './recorder'
import { TerrainGrid } from './terrain'
import { receptionNm, type VorRow, VorRouter, vorsFromRows } from './vor'

const world = TerrainGrid.fromBytes(gunzipSync(readFileSync(join(process.cwd(), 'resources/terrain.bin.gz'))))
const index = new AirportIndex(airportsFromRows(JSON.parse(readFileSync('resources/airports.json', 'utf8')) as AirportRow[]))
const vors = vorsFromRows(JSON.parse(readFileSync('resources/navaids.json', 'utf8')) as VorRow[])

// On the equator one degree of longitude is 60 nm.
const point = (ident: string, lon: number): Stop => ({ ident, name: ident, lat: 0, lon })
const vor = (ident: string, lon: number, serviceClass: Vor['serviceClass'] = 'L'): Vor => ({
  ident,
  name: ident,
  type: 'VOR',
  freqKhz: 113_000,
  lat: 0,
  lon,
  elevationFt: 0,
  serviceClass,
  country: 'XX',
  magVarDeg: 0
})
const router = (stations: Vor[], segmentOk = (_a: Stop, _b: Stop) => true, searchNm = 1000) =>
  new VorRouter(stations, searchNm, segmentOk, (stop: Stop) => `${stop.ident}@${stop.lat},${stop.lon}`)

describe('receptionNm', () => {
  it('uses low-altitude ranges, since VFR flying stays low', () => {
    expect(receptionNm({ serviceClass: 'T' })).toBe(25)
    expect(receptionNm({ serviceClass: 'L' })).toBe(40)
    expect(receptionNm({ serviceClass: 'H' })).toBe(40)
  })
})

describe('VorRouter', () => {
  // Low stations reach 40 nm, so neighbours up to 80 nm apart can be linked.
  const chain = [vor('V1', 0.5), vor('V2', 1.75), vor('V3', 3), vor('V4', 4.25)]

  it('chains VORs from departure to arrival', () => {
    const route = router(chain).route(point('A', 0), point('B', 4.75))
    expect(route?.fixes.map((f) => f.ident)).toEqual(['V1', 'V2', 'V3', 'V4'])
    expect(route?.distanceNm).toBeCloseTo(285, 0)
    expect(route?.fixes[0].freqMhz).toBe(113)
  })

  it('finds nothing when a gap is too wide to receive across', () => {
    const gappy = [vor('V1', 0.5), vor('V4', 4.25)]
    expect(router(gappy).route(point('A', 0), point('B', 4.75))).toBeNull()
  })

  it('goes around a stretch that breaks the limits', () => {
    const detour = [...chain, { ...vor('N', 2.4), lat: 0.4 }]
    const blocked = (a: Stop, b: Stop) => !(a.name === 'V2' && b.name === 'V3')
    const route = router(detour, blocked).route(point('A', 0), point('B', 4.75))
    expect(route?.fixes.map((f) => f.ident)).toEqual(['V1', 'V2', 'N', 'V3', 'V4'])
  })

  it('does not look past the search distance', () => {
    expect(router(chain, () => true, 200).route(point('A', 0), point('B', 4.75))).toBeNull()
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

  it('leaves legs without routes when it is off', () => {
    const journey = plan('KSAN', 'KBOS', {}, false)
    expect(journey.legs.every((leg) => leg.vorRoute === undefined)).toBe(true)
  })
})
