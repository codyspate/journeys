import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { type Airport, NO_LIMITS, PERFORMANCE_PRESETS, type Vor } from '../shared/journey'
import { AirportIndex, airportsFromRows, type AirportRow } from './airports'
import { type Ground, legBrief, type TownRow, townsFromRows, variationNear, vfrAltitude, windTriangle } from './legBrief'
import { createJourney } from './planner'
import { TerrainGrid } from './terrain'
import { type VorRow, vorsFromRows } from './vor'

const world = TerrainGrid.fromBytes(gunzipSync(readFileSync(join(process.cwd(), 'resources/terrain.bin.gz'))))
const everywhere = new AirportIndex(airportsFromRows(JSON.parse(readFileSync('resources/airports.json', 'utf8')) as AirportRow[]))
const vors = vorsFromRows(JSON.parse(readFileSync('resources/navaids.json', 'utf8')) as VorRow[])
const towns = townsFromRows(JSON.parse(readFileSync('resources/places.json', 'utf8')) as TownRow[])

describe('vfrAltitude', () => {
  it('uses odd thousands plus 500 eastbound and even westbound, clear of the floor', () => {
    expect(vfrAltitude(true, 5200, null)).toEqual({ altitudeFt: 5500, heldByCeiling: false })
    expect(vfrAltitude(false, 5200, null)).toEqual({ altitudeFt: 6500, heldByCeiling: false })
    expect(vfrAltitude(true, 5500, null).altitudeFt).toBe(5500)
  })

  it('starts at 3,500 or 4,500 over low ground', () => {
    expect(vfrAltitude(true, 800, null).altitudeFt).toBe(3500)
    expect(vfrAltitude(false, 800, null).altitudeFt).toBe(4500)
  })

  it('stays under the ceiling, and says when that means not clearing the ground', () => {
    expect(vfrAltitude(true, 8200, 9000)).toEqual({ altitudeFt: 7500, heldByCeiling: true })
    expect(vfrAltitude(false, 8200, 9000)).toEqual({ altitudeFt: 8500, heldByCeiling: false })
  })
})

describe('windTriangle', () => {
  it('is still air without wind', () => {
    expect(windTriangle(90, 120, null)).toEqual({ headingTrue: null, gsKts: 120 })
  })

  it('slows down into a headwind and speeds up with a tailwind', () => {
    expect(windTriangle(90, 120, { fromTrue: 90, kts: 20 }).gsKts).toBeCloseTo(100)
    expect(windTriangle(90, 120, { fromTrue: 270, kts: 20 }).gsKts).toBeCloseTo(140)
  })

  it('turns into a crosswind', () => {
    // 20 kt from the south on an eastbound course: about 10° right, towards the wind.
    const { headingTrue, gsKts } = windTriangle(90, 120, { fromTrue: 180, kts: 20 })
    expect(headingTrue).toBeCloseTo(99.6, 1)
    expect(gsKts).toBeCloseTo(118.3, 1)
  })
})

describe('variationNear', () => {
  const vor = (lat: number, lon: number, magVarDeg: number) => ({ lat, lon, magVarDeg }) as Vor
  it('takes it from the nearest VOR, or none when none is near', () => {
    expect(variationNear({ lat: 0, lon: 0 }, [vor(0, 1, 5), vor(0, 3, -7)])).toBe(5)
    expect(variationNear({ lat: 0, lon: 0 }, [vor(0, 20, 5)])).toBeNull()
  })
})

describe('legBrief', () => {
  const flat: Ground = { elevationFt: () => 500, isWater: () => false }
  const field = (ident: string, lat: number, lon: number, runways: Airport['runways'] = []): Airport => ({
    ident,
    name: ident,
    lat,
    lon,
    elevationFt: 500,
    size: 'small',
    city: '',
    country: 'XX',
    runwayFt: 3000,
    hardSurface: true,
    scheduled: false,
    runways
  })
  // An eastbound leg along the equator, with towns every 10 nm and the arrival's runway 09/27.
  const from = field('AAA', 0, 0)
  const to = field('BBB', 0, 1, [{ ends: ['09', '27'], headingTrue: 90, lengthFt: 4000, hardSurface: true }])
  const index = new AirportIndex([from, to])
  const journey = createJourney(
    { name: '', originIdent: 'AAA', destinationIdent: 'BBB', performance: { ...PERFORMANCE_PRESETS[1], cruiseKts: 120, burnGph: 10 }, maxLegMinutes: 240 },
    index,
    'j',
    0
  )
  const leg = journey.legs[0]
  const townsAlong = [10, 20, 30, 40, 50].map((nm) => ({ name: `Town ${nm}`, lat: 0.02, lon: nm / 60, population: 20_000 }))
  const brief = (wind: { fromTrue: number; kts: number } | null) =>
    legBrief(journey, leg, { airports: [from, to], vors: [], towns: townsAlong, ground: flat, wind })

  it('lists checkpoints about every 12 nm, ending at the arrival', () => {
    const log = brief(null).navLog
    expect(log.at(-1)).toMatchObject({ kind: 'arrival', ident: 'BBB' })
    expect(log.length).toBeGreaterThanOrEqual(5)
    for (const row of log) expect(row.legNm).toBeLessThanOrEqual(18)
    expect(log.at(-1)!.totalNm).toBeCloseTo(60, 0)
  })

  it('follows the route, so courses stay on the line even past an off-track town', () => {
    for (const row of brief(null).navLog) expect(row.courseDeg).toBe(90)
  })

  it('works out time and fuel at cruise, and for the wind when known', () => {
    const still = brief(null).navLog.at(-1)!
    expect(still.totalMinutes).toBeCloseTo(30, 0)
    expect(still.fuelUsedGal).toBeCloseTo(5, 1)
    expect(still.headingDeg).toBeNull()
    const windy = brief({ fromTrue: 90, kts: 20 }).navLog.at(-1)!
    expect(windy.totalMinutes).toBeCloseTo(36, 0)
  })

  it('suggests a VFR cruise and draws the ground', () => {
    const b = brief(null)
    expect(b.cruise).toMatchObject({ eastbound: true, highestGroundFt: 500, suggestedFt: 3500, magnetic: false })
    expect(b.profile.length).toBeGreaterThan(10)
    expect(b.totalNm).toBeCloseTo(60, 0)
  })

  it('gives the arrival a pattern altitude and picks the runway into the wind', () => {
    expect(brief({ fromTrue: 260, kts: 12 }).arrival).toMatchObject({ elevationFt: 500, patternAltitudeFt: 1500, likely: '27' })
    expect(brief({ fromTrue: 80, kts: 12 }).arrival?.likely).toBe('09')
    expect(brief(null).arrival?.likely).toBeNull()
    expect(brief({ fromTrue: 80, kts: 1 }).arrival?.likely).toBeNull()
  })

  it('briefs a real VOR leg in the US with towns, VORs and magnetic courses', () => {
    const real = createJourney(
      {
        name: '',
        originIdent: 'KSAN',
        destinationIdent: 'KBOS',
        performance: PERFORMANCE_PRESETS[1],
        maxLegMinutes: 240,
        limits: { ...NO_LIMITS, vorRoutes: true }
      },
      everywhere,
      'j',
      0,
      world,
      vors
    )
    const b = legBrief(real, real.legs[0], { airports: everywhere.all, vors, towns, ground: world, wind: null })
    expect(b.navLog.some((row) => row.kind === 'vor')).toBe(true)
    expect(b.navLog.some((row) => row.kind === 'town')).toBe(true)
    expect(b.cruise.magnetic).toBe(true)
    expect(b.navLog.at(-1)?.kind).toBe('arrival')
  })
})
