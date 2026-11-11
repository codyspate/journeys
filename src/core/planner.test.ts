import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { DEFAULT_DESCENT, NO_LIMITS, type Performance, PERFORMANCE_PRESETS, type RouteLimits, type Stop } from '../shared/journey'
import type { LogbookFlight } from '../shared/logbook'
import { AirportIndex, airportsFromRows, type AirportRow } from './airports'
import {
  addVia,
  applyFlight,
  checkSettings,
  createJourney,
  currentStop,
  editRoute,
  rangeNm,
  reachOptions,
  reflow,
  removeVia,
  trackPosition,
  updateSettings
} from './planner'
import { distanceNm } from './recorder'
import { alongGreatCircle, type Terrain, TerrainGrid } from './terrain'

const world = TerrainGrid.fromBytes(gunzipSync(readFileSync(join(process.cwd(), 'resources/terrain.bin.gz'))))

const index = new AirportIndex(
  airportsFromRows(JSON.parse(readFileSync(join(process.cwd(), 'resources/airports.json'), 'utf8')) as AirportRow[])
)
const comanche = PERFORMANCE_PRESETS[0]
const create = (from = 'KSAN', to = 'KBOS', performance: Performance = comanche, maxLegMinutes = 240) =>
  createJourney({ name: '', originIdent: from, destinationIdent: to, performance, maxLegMinutes }, index, 'j1', 1000)

const planned = (j: ReturnType<typeof create>) => j.legs.filter((l) => l.status === 'planned')
const stop = (ident: string): Stop => {
  const { name, lat, lon } = index.get(ident)!
  return { ident, name, lat, lon }
}

function flight(fromIdent: string, toIdent: string, overrides: Partial<LogbookFlight> = {}): LogbookFlight {
  const from = index.get(fromIdent)!
  const to = index.get(toIdent)!
  return {
    id: `${fromIdent}-${toIdent}`,
    aircraft: { title: 'Comanche', livery: '', atcId: '' },
    status: 'complete',
    startedAt: 0,
    takeoffAt: 60_000,
    landedAt: 3_660_000,
    endedAt: 3_700_000,
    origin: { lat: from.lat, lon: from.lon },
    destination: { lat: to.lat, lon: to.lon },
    startedAirborne: false,
    distanceNm: distanceNm(from.lat, from.lon, to.lat, to.lon),
    maxAltitudeFt: 9000,
    maxG: 1.3,
    fuelStartGal: 60,
    fuelEndGal: 30,
    landings: [],
    events: [],
    ...overrides
  }
}

describe('San Diego to Boston in the Comanche', () => {
  const journey = create()
  const legs = planned(journey)

  it('starts and ends in the right places, with connected legs', () => {
    expect(legs[0].from.ident).toBe('KSAN')
    expect(legs.at(-1)!.to.ident).toBe('KBOS')
    legs.slice(1).forEach((leg, i) => expect(leg.from.ident).toBe(legs[i].to.ident))
  })

  it('uses a realistic number of stops, all within range', () => {
    expect(legs.length).toBeGreaterThanOrEqual(4)
    expect(legs.length).toBeLessThanOrEqual(6)
    expect(legs.every((leg) => !leg.beyondRange && leg.distanceNm <= rangeNm(comanche))).toBe(true)
  })

  it('marks later legs as tentative', () => {
    expect(legs.slice(0, 2).every((leg) => leg.confidence === 'firm')).toBe(true)
    expect(legs.slice(2).every((leg) => leg.confidence === 'tentative')).toBe(true)
  })

  it('stops more often for a shorter preferred session', () => {
    expect(planned(create('KSAN', 'KBOS', comanche, 120)).length).toBeGreaterThan(legs.length)
  })
})

describe('planning', () => {
  it('needs only one leg when the trip is within range', () => {
    expect(planned(create('KSAN', 'KLAX'))).toHaveLength(1)
  })

  it('avoids military fields as automatic stops', () => {
    const military = /army|air force|afb|naval|air base/i
    for (const minutes of [120, 150, 240]) {
      const stops = planned(create('KSAN', 'KBOS', comanche, minutes)).slice(0, -1)
      expect(stops.filter((leg) => military.test(leg.to.name))).toEqual([])
    }
  })

  it('rejects an airport it does not know', () => {
    expect(() => create('NOPE')).toThrow('NOPE')
  })

  it('still plans across an ocean, flagging the leg without refusing', () => {
    const legs = planned(create('KSFO', 'PHNL', PERFORMANCE_PRESETS[1]))
    expect(legs.at(-1)!.to.ident).toBe('PHNL')
    expect(legs.some((leg) => leg.beyondRange)).toBe(true)
  })

  it('only offers runways the aircraft can use', () => {
    const jet = PERFORMANCE_PRESETS[2]
    const legs = planned(create('KSAN', 'KBOS', { ...jet, usableFuelGal: 1200 }, 200))
    for (const leg of legs.slice(0, -1)) {
      const airport = index.get(leg.to.ident)!
      expect(airport.runwayFt).toBeGreaterThanOrEqual(jet.minRunwayFt)
      expect(airport.hardSurface).toBe(true)
    }
  })
})

describe('track position', () => {
  it('measures along and across the route', () => {
    const from = stop('KSAN')
    const to = stop('KBOS')
    const onRoute = trackPosition(from, to, to)
    expect(onRoute.alongNm).toBeCloseTo(distanceNm(from.lat, from.lon, to.lat, to.lon), 0)
    expect(onRoute.crossNm).toBeLessThan(1)
    expect(trackPosition(from, to, stop('PHNL')).alongNm).toBeLessThan(0)
  })
})

describe('updating the plan as you go', () => {
  it('re-plans from an unplanned stop and keeps the flown leg', () => {
    const journey = create()
    const updated = applyFlight(journey, flight('KSAN', 'KPHX'), index)!
    expect(updated.legs[0]).toMatchObject({ status: 'flown', flightId: 'KSAN-KPHX', fuelGal: 30 })
    expect(updated.legs[0].to.ident).toBe('KPHX')
    expect(currentStop(updated).ident).toBe('KPHX')
    expect(planned(updated)[0].from.ident).toBe('KPHX')
    expect(planned(updated).at(-1)!.to.ident).toBe('KBOS')
  })

  it('never changes flown legs when re-planning', () => {
    const flownOnce = applyFlight(create(), flight('KSAN', 'KPHX'), index)!
    const shorter = reflow({ ...flownOnce, maxLegMinutes: 90 }, index.all)
    expect(shorter.legs[0]).toEqual(flownOnce.legs[0])
  })

  it('completes the Journey on reaching the destination', () => {
    const updated = applyFlight(create('KSAN', 'KLAX'), flight('KSAN', 'KLAX'), index)!
    expect(updated.status).toBe('complete')
    expect(planned(updated)).toHaveLength(0)
  })

  it('leaves the Journey alone for a flight from somewhere else', () => {
    expect(applyFlight(create(), flight('KPHX', 'KTUS'), index)).toBeNull()
  })

  it('leaves the Journey alone for a local flight back to the same field', () => {
    expect(applyFlight(create(), flight('KSAN', 'KSAN'), index)).toBeNull()
  })

  it('ignores flights that did not complete, and duplicates', () => {
    expect(applyFlight(create(), flight('KSAN', 'KPHX', { status: 'ended-early' }), index)).toBeNull()
    const updated = applyFlight(create(), flight('KSAN', 'KPHX'), index)!
    expect(applyFlight(updated, flight('KSAN', 'KPHX'), index)).toBeNull()
  })

  it('records an off-airport landing', () => {
    const f = flight('KSAN', 'KPHX', { destination: { lat: 33.0, lon: -113.5 } })
    expect(currentStop(applyFlight(create(), f, index)!).ident).toBe('OFF-FIELD')
  })

  it('routes through a chosen stop, and can remove it', () => {
    const withStop = addVia(create(), stop('KDEN'), index.all)
    expect(planned(withStop).some((leg) => leg.to.ident === 'KDEN' && leg.pinned)).toBe(true)
    expect(planned(removeVia(withStop, 'KDEN', index.all)).some((leg) => leg.pinned && leg.to.ident === 'KDEN')).toBe(false)
  })

  it('clears a chosen stop once reached', () => {
    const withStop = addVia(create(), stop('KPHX'), index.all)
    expect(applyFlight(withStop, flight('KSAN', 'KPHX'), index)!.via).toEqual([])
  })
})

describe('editing a route', () => {
  const idents = (j: ReturnType<typeof create>) => planned(j).map((leg) => leg.to.ident)
  const connected = (j: ReturnType<typeof create>) =>
    planned(j)
      .slice(1)
      .forEach((leg, i) => expect(leg.from.ident).toBe(planned(j)[i].to.ident))

  it('removes a stop the planner chose, and does not choose it again', () => {
    const journey = create()
    const unwanted = idents(journey)[1]
    const edited = editRoute(journey, { kind: 'remove', ident: unwanted }, index)
    expect(idents(edited)).not.toContain(unwanted)
    expect(idents(edited).at(-1)).toBe('KBOS')
    connected(edited)
  })

  it('does not bring a removed chosen stop straight back', () => {
    const withStop = editRoute(create(), { kind: 'add', ident: 'KDEN' }, index)
    expect(idents(editRoute(withStop, { kind: 'remove', ident: 'KDEN' }, index))).not.toContain('KDEN')
  })

  it('lets a removed airport be added again', () => {
    const removed = editRoute(editRoute(create(), { kind: 'add', ident: 'KDEN' }, index), { kind: 'remove', ident: 'KDEN' }, index)
    const back = editRoute(removed, { kind: 'add', ident: 'KDEN' }, index)
    expect(idents(back)).toContain('KDEN')
    expect(back.avoid).not.toContain('KDEN')
  })

  it('swaps a planned stop for another airport, keeping the order of chosen stops', () => {
    const start = editRoute(create(), { kind: 'add', ident: 'KORD' }, index)
    const auto = idents(start)[0]
    const edited = editRoute(start, { kind: 'replace', ident: auto, withIdent: 'KPHX' }, index)
    expect(edited.via.map((v) => v.ident)).toEqual(['KPHX', 'KORD'])
    expect(idents(edited)).not.toContain(auto)
    connected(edited)
  })

  it('reorders chosen stops, and a later add does not undo it', () => {
    const start = editRoute(editRoute(create(), { kind: 'add', ident: 'KPHX' }, index), { kind: 'add', ident: 'KORD' }, index)
    expect(start.via.map((v) => v.ident)).toEqual(['KPHX', 'KORD'])
    const moved = editRoute(start, { kind: 'move', ident: 'KPHX', offset: 1 }, index)
    expect(moved.via.map((v) => v.ident)).toEqual(['KORD', 'KPHX'])
    const added = editRoute(moved, { kind: 'add', ident: 'KLAX' }, index)
    expect(added.via.map((v) => v.ident).filter((i) => i !== 'KLAX')).toEqual(['KORD', 'KPHX'])
  })

  it('changes the destination and keeps what has been flown', () => {
    const flown = applyFlight(create(), flight('KSAN', 'KPHX'), index)!
    const edited = editRoute(flown, { kind: 'destination', ident: 'KJFK' }, index)
    expect(edited.destination.ident).toBe('KJFK')
    expect(edited.legs.filter((l) => l.status === 'flown').map((l) => l.to.ident)).toEqual(['KPHX'])
    expect(planned(edited)[0].from.ident).toBe('KPHX')
    expect(edited.name).toBe('KSAN to KJFK')
  })

  it('keeps a name the player chose when the endpoints change', () => {
    const named = { ...create(), name: 'Coast to coast' }
    expect(editRoute(named, { kind: 'destination', ident: 'KJFK' }, index).name).toBe('Coast to coast')
  })

  it('changes the departure before the first flight, but not after', () => {
    expect(editRoute(create(), { kind: 'origin', ident: 'KLAX' }, index).legs[0].from.ident).toBe('KLAX')
    const flown = applyFlight(create(), flight('KSAN', 'KPHX'), index)!
    expect(() => editRoute(flown, { kind: 'origin', ident: 'KLAX' }, index)).toThrow('already left')
  })

  it('does not add a stop that would be a zero-length leg', () => {
    expect(() => editRoute(create(), { kind: 'add', ident: 'KBOS' }, index)).toThrow('destination')
    expect(() => editRoute(create(), { kind: 'add', ident: 'KSAN' }, index)).toThrow('already at')
  })

  it('goes back to the suggested route', () => {
    const journey = create()
    const edited = editRoute(editRoute(journey, { kind: 'add', ident: 'KDEN' }, index), { kind: 'remove', ident: idents(journey)[0] }, index)
    const reset = editRoute(edited, { kind: 'reset' }, index)
    expect(reset.via).toEqual([])
    expect(reset.avoid).toEqual([])
    expect(idents(reset)).toEqual(idents(journey))
  })
})

describe('reach while flying', () => {
  // Heading for Tucumcari with Amarillo about 95 NM beyond it.
  const journey = {
    ...create('KABQ', 'KOKC', comanche, 90),
    via: [] as Stop[]
  }
  const toTucumcari = addVia(journey, stop('KTCC'), index.all)
  const near = index.get('KTCC')!

  it('offers a stop further on when fuel and tailwind allow it', () => {
    const result = reachOptions(toTucumcari, { lat: near.lat, lon: near.lon - 0.5, fuelGal: 45, burnGph: 14, gsKts: 190 }, index.all)!
    expect(result.plannedStop.ident).toBe('KTCC')
    expect(result.canReachPlanned).toBe(true)
    expect(result.further).not.toBeNull()
    expect(result.further!.reserveMinutes).toBeGreaterThanOrEqual(comanche.reserveMinutes)
  })

  it('offers nothing further when there is no spare fuel', () => {
    const result = reachOptions(toTucumcari, { lat: near.lat, lon: near.lon - 0.5, fuelGal: 13, burnGph: 14, gsKts: 150 }, index.all)!
    expect(result.further).toBeNull()
  })

  it('offers a closer stop when the plan is out of reach', () => {
    const result = reachOptions(toTucumcari, { lat: near.lat, lon: near.lon - 2, fuelGal: 11, burnGph: 14, gsKts: 120 }, index.all)!
    expect(result.canReachPlanned).toBe(false)
    expect(result.closer).not.toBeNull()
  })
})

describe('route limits', () => {
  const settingsWith = (limits: Partial<RouteLimits>, maxLegMinutes = 240) => ({
    performance: comanche,
    maxLegMinutes,
    limits: { ...NO_LIMITS, ...limits },
    descent: DEFAULT_DESCENT
  })
  const withLimits = (limits: Partial<RouteLimits>, terrain?: Terrain, from = 'KSAN', to = 'KBOS') =>
    createJourney({ name: '', originIdent: from, destinationIdent: to, ...settingsWith(limits) }, index, 'j1', 1000, terrain)

  /** Flat dry land, except one tall mountain or one lake around a point. */
  const feature = (at: { lat: number; lon: number }, kind: 'mountain' | 'lake'): Terrain => ({
    profile(a, b) {
      const hits = [...alongGreatCircle(a, b, 2)].some((p) => distanceNm(p.lat, p.lon, at.lat, at.lon) < 20)
      return kind === 'mountain' ? { highestFt: hits ? 15000 : 1000, longestWaterNm: 0 } : { highestFt: 0, longestWaterNm: hits ? 40 : 0 }
    }
  })
  const midpointOfFirstLeg = () => {
    const leg = planned(create())[0]
    return [...alongGreatCircle(leg.from, leg.to)].at(Math.floor(leg.distanceNm / 3))!
  }

  it('keeps every leg within the distance cap', () => {
    for (const leg of planned(withLimits({ maxLegNm: 250 }))) expect(leg.distanceNm).toBeLessThanOrEqual(250)
  })

  it('stops suggesting tiny hops', () => {
    const legs = planned(withLimits({ minLegNm: 300 }))
    expect(legs.filter((leg) => leg.belowMinimum)).toEqual([])
  })

  it('skips airports that are too high', () => {
    const legs = planned(withLimits({ maxAirportElevationFt: 2000 }))
    for (const leg of legs.slice(0, -1)) expect(index.get(leg.to.ident)!.elevationFt).toBeLessThanOrEqual(2000)
  })

  it('routes around terrain that is too high, and only mentions it when it does not', () => {
    const mountain = feature(midpointOfFirstLeg(), 'mountain')
    const unlimited = planned(withLimits({}, mountain))
    expect(unlimited.some((leg) => leg.highestTerrainFt === 15000)).toBe(true)
    expect(unlimited.some((leg) => leg.aboveCeiling)).toBe(false)

    const limited = planned(withLimits({ maxAltitudeFt: 12000 }, mountain))
    expect(limited.every((leg) => leg.highestTerrainFt === 1000)).toBe(true)
  })

  it('avoids long water crossings', () => {
    const lake = feature(midpointOfFirstLeg(), 'lake')
    expect(planned(withLimits({}, lake)).some((leg) => leg.longestWaterNm === 40)).toBe(true)
    expect(planned(withLimits({ maxWaterNm: 25 }, lake)).every((leg) => leg.longestWaterNm === 0)).toBe(true)
  })

  it('still plans a route when a limit cannot be met, and says so', () => {
    const everywhere: Terrain = { profile: () => ({ highestFt: 14000, longestWaterNm: 0 }) }
    const legs = planned(withLimits({ maxAltitudeFt: 10000 }, everywhere))
    expect(legs.at(-1)!.to.ident).toBe('KBOS')
    expect(legs.every((leg) => leg.aboveCeiling)).toBe(true)
  }, 20_000) // Every leg in the country breaking the limit is the slowest case the planner has.

  it('finds a lower way across the Rockies with the real terrain', () => {
    const before = planned(withLimits({}, world, 'KAPA', 'KSLC'))
    const after = planned(withLimits({ maxAltitudeFt: 12500, terrainClearanceFt: 1000 }, world, 'KAPA', 'KSLC'))
    const highest = (legs: typeof before) => Math.max(...legs.map((leg) => leg.highestTerrainFt!))
    expect(highest(before)).toBeGreaterThan(11500)
    expect(highest(after)).toBeLessThanOrEqual(11500)
  })

  it('applies new settings to what has not been flown', () => {
    const flown = applyFlight(create(), flight('KSAN', 'KPHX'), index)!
    const updated = updateSettings(flown, settingsWith({ maxLegNm: 200 }, 240), index.all)
    expect(updated.legs[0]).toEqual(flown.legs[0])
    expect(planned(updated).every((leg) => leg.distanceNm <= 200)).toBe(true)
    expect(updated.limits.maxLegNm).toBe(200)
  })

  it('rejects numbers it cannot plan with', () => {
    expect(() => checkSettings(settingsWith({ maxLegNm: 0 }))).toThrow('Longest leg distance')
    expect(() => checkSettings({ ...settingsWith({}), performance: { ...comanche, cruiseKts: 0 } })).toThrow('Cruise speed')
    expect(() => checkSettings(settingsWith({ minLegNm: 5000 }))).toThrow('Shortest leg')
    expect(checkSettings(settingsWith({}))).toBeTruthy()
  })
})

describe('dragging a stop to another airport', () => {
  const stopsOf = (j: ReturnType<typeof create>) => planned(j).map((leg) => leg.to.ident).slice(0, -1)
  const coastToCoast = () => create('KSAN', 'KBOS', comanche, 180)

  it('keeps every stop before it, and every stop after it when asked', () => {
    const journey = coastToCoast()
    const before = stopsOf(journey)
    expect(before.length).toBeGreaterThanOrEqual(4)
    const moved = editRoute(journey, { kind: 'drag', ident: before[1], withIdent: 'KDEN', rest: 'keep' }, index)
    const after = stopsOf(moved)
    expect(after.slice(0, 2)).toEqual([before[0], 'KDEN'])
    // Every later stop stays, in order. A gap that's now too long gets one filled in.
    const kept = after.filter((ident) => before.slice(2).includes(ident))
    expect(kept).toEqual(before.slice(2))
    expect(moved.avoid).toContain(before[1])
  })

  it('re-plans everything after it when asked, from the new airport', () => {
    const journey = coastToCoast()
    const before = stopsOf(journey)
    const moved = editRoute(journey, { kind: 'drag', ident: before[1], withIdent: 'KDEN', rest: 'replan' }, index)
    const after = stopsOf(moved)
    expect(after.slice(0, 2)).toEqual([before[0], 'KDEN'])
    expect(planned(moved).at(-1)!.to.ident).toBe('KBOS')
    expect(moved.via.map((v) => v.ident)).toEqual([before[0], 'KDEN'])
  })

  it('re-planning starts fresh after the moved stop, even past stops the player chose', () => {
    const journey = editRoute(coastToCoast(), { kind: 'add', ident: 'KORD' }, index)
    const first = stopsOf(journey)[0]
    const moved = editRoute(journey, { kind: 'drag', ident: first, withIdent: 'KLAS', rest: 'replan' }, index)
    expect(stopsOf(moved)[0]).toBe('KLAS')
    expect(moved.via.map((v) => v.ident)).toEqual(['KLAS'])
  })

  it('refuses airports already on the route, and stops already flown', () => {
    const journey = coastToCoast()
    const [first, second] = stopsOf(journey)
    expect(() => editRoute(journey, { kind: 'drag', ident: first, withIdent: second, rest: 'keep' }, index)).toThrow('already on your route')
    expect(() => editRoute(journey, { kind: 'drag', ident: 'KSAN', withIdent: 'KLAX', rest: 'keep' }, index)).toThrow("isn't a stop")
    expect(() => editRoute(journey, { kind: 'drag', ident: 'KPHX', withIdent: 'KLAX', rest: 'keep' }, index)).toThrow("isn't a stop")
  })
})
