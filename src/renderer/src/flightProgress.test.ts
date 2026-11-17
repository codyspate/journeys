import { describe, expect, it } from 'vitest'
import type { LiveSim } from '../../shared/airframe'
import type { NavLogRow } from '../../shared/brief'
import { DEFAULT_DESCENT, type Leg, type VorFix } from '../../shared/journey'
import { descentAhead, homeMode, nextCheckpoint, routeProgress } from './flightProgress'

// On the equator one degree of longitude is 60 nm.
const stop = (ident: string, lon: number) => ({ ident, name: ident, lat: 0, lon })
const fix = (ident: string, lat: number, lon: number): VorFix => ({ ident, name: ident, type: 'VOR', freqMhz: 114, lat, lon, magVarDeg: 0 })
const leg = { from: stop('AAA', 0), to: stop('BBB', 2), vorRoute: null } as unknown as Leg

const live = (changes: Partial<LiveSim>): LiveSim => ({
  connected: true,
  aircraftKey: 'k',
  aircraftName: 'Cessna',
  lat: 0,
  lon: 0,
  onGround: true,
  nearAirport: null,
  headingTrue: 0,
  altFt: 0,
  gsKts: 0,
  paused: false,
  flightId: null,
  ...changes
})

describe('homeMode', () => {
  it('is an overview with the sim off or no aircraft loaded', () => {
    expect(homeMode(live({ connected: false }), leg)).toBe('overview')
    expect(homeMode(live({ lat: null, lon: null }), leg)).toBe('overview')
  })

  it('is preflight on the ground at the leg start, and an overview anywhere else on the ground', () => {
    expect(homeMode(live({ lon: 0.01 }), leg)).toBe('preflight')
    expect(homeMode(live({ lon: 1 }), leg)).toBe('overview')
    expect(homeMode(live({}), null)).toBe('overview')
  })

  it('is flying in the air, or while a flight is being logged on the ground', () => {
    expect(homeMode(live({ onGround: false, lon: 1 }), leg)).toBe('flying')
    expect(homeMode(live({ flightId: 'f' }), leg)).toBe('flying')
    expect(homeMode(live({ onGround: false }), null)).toBe('flying')
  })
})

describe('routeProgress', () => {
  it('measures along a direct leg', () => {
    const p = routeProgress(leg, { lat: 0.05, lon: 0.5 })
    expect(p.alongNm).toBeCloseTo(30, 0)
    expect(p.toGoNm).toBeCloseTo(90, 0)
    expect(p.offRouteNm).toBeCloseTo(3, 0)
  })

  it('measures along the VORs on a routed leg', () => {
    const dogleg = { ...leg, vorRoute: [fix('V1', 1, 1)] }
    // Halfway up the first stretch, which runs from AAA to V1.
    const p = routeProgress(dogleg, { lat: 0.5, lon: 0.5 })
    expect(p.totalNm).toBeCloseTo(169.7, 0)
    expect(p.alongNm).toBeCloseTo(42.4, 0)
    expect(p.offRouteNm).toBeLessThan(0.5)
  })

  it('stays at the ends before departure and after arrival', () => {
    expect(routeProgress(leg, { lat: 0, lon: -0.1 }).alongNm).toBe(0)
    expect(routeProgress(leg, { lat: 0, lon: 2.1 }).toGoNm).toBe(0)
  })
})

describe('nextCheckpoint', () => {
  const rows = [10, 25, 40].map((totalNm) => ({ name: `R${totalNm}`, totalNm }) as NavLogRow)

  it('is the first one not yet passed', () => {
    expect(nextCheckpoint(rows, 0)?.row.name).toBe('R10')
    expect(nextCheckpoint(rows, 12)).toMatchObject({ index: 1, inNm: 13 })
    expect(nextCheckpoint(rows, 41)).toBeNull()
  })
})

describe('descentAhead', () => {
  it('works out how far out to start down on the set angle', () => {
    // 6,500 ft to 1,500 ft above a sea-level field at 3° is about 15.7 nm.
    const d = descentAhead(6500, 120, 40, 0, DEFAULT_DESCENT)
    expect(d.levelOffFt).toBe(1500)
    expect(d.descentNm).toBeCloseTo(15.7, 1)
    expect(d.toTodNm).toBeCloseTo(24.3, 1)
    expect(d.minutes).toBeCloseTo(12.1, 1)
  })

  it('has no time when not really moving', () => {
    expect(descentAhead(6500, 0, 40, 0, DEFAULT_DESCENT).minutes).toBeNull()
  })
})
