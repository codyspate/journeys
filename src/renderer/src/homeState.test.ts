import { describe, expect, it } from 'vitest'
import type { AirframeRecord, LiveSim } from '../../shared/airframe'
import { DEFAULT_DESCENT, type Journey, type Leg, NO_LIMITS, type Stop } from '../../shared/journey'
import { aircraftLabels, currentJourney, progressOf, readiness } from './homeState'

const stop = (ident: string, lat: number, lon: number): Stop => ({ ident, name: ident, lat, lon })
const KRIU = stop('KRIU', 38.4868, -121.1028)
const KSAC = stop('KSAC', 38.5124, -121.4935)
const KRNO = stop('KRNO', 39.4991, -119.7681)

const leg = (from: Stop, to: Stop, status: Leg['status'] = 'planned'): Leg => ({
  id: `${from.ident}-${to.ident}`,
  from,
  to,
  status,
  distanceNm: 100,
  minutes: 45,
  fuelGal: 10,
  beyondRange: false,
  beyondSession: false,
  pinned: false,
  confidence: 'firm',
  flightId: null,
  aircraft: null
})

function journey(id: string, lastOpenedAt: number, legs: Leg[], status: Journey['status'] = 'active'): Journey {
  return {
    id,
    name: id,
    createdAt: 0,
    lastOpenedAt,
    status,
    origin: legs[0].from,
    destination: legs.at(-1)!.to,
    via: [],
    avoid: [],
    performance: PERFORMANCE,
    maxLegMinutes: 180,
    limits: NO_LIMITS,
    descent: DEFAULT_DESCENT,
    legs
  }
}
const PERFORMANCE = { name: 'Comanche', cruiseKts: 160, burnGph: 14, usableFuelGal: 60, reserveMinutes: 45, minRunwayFt: 2000, needsHardSurface: false }

function parked(key: string, at: Stop): AirframeRecord {
  return {
    key,
    location: { ident: at.ident, name: at.name },
    snapshot: {
      id: key,
      name: key,
      capturedAt: '2026-11-01T00:00:00.000Z',
      aircraft: { title: key.split('|')[0], livery: '', atcId: '' },
      profileId: 'default',
      engineCount: 1,
      parked: true,
      values: { 'position.latitude': at.lat, 'position.longitude': at.lon }
    }
  }
}

const live = (overrides: Partial<LiveSim> = {}): LiveSim => ({
  connected: true,
  aircraftKey: 'Comanche|',
  aircraftName: 'Comanche',
  lat: KRIU.lat,
  lon: KRIU.lon,
  onGround: true,
  nearAirport: { ident: 'KRIU', name: 'KRIU' },
  headingTrue: 90,
  altFt: 200,
  gsKts: 0,
  paused: false,
  flightId: null,
  ...overrides
})

describe('which Journey comes first', () => {
  it('is the active one opened most recently', () => {
    const older = journey('older', 1, [leg(KRIU, KSAC)])
    const newer = journey('newer', 2, [leg(KRIU, KSAC)])
    const done = journey('done', 3, [leg(KRIU, KSAC, 'flown')], 'complete')
    expect(currentJourney([older, newer, done])?.id).toBe('newer')
    expect(currentJourney([done])).toBeNull()
  })

  it('knows the next leg and what is left', () => {
    const progress = progressOf(journey('j', 1, [leg(KRIU, KSAC, 'flown'), leg(KSAC, KRNO), leg(KRNO, KRIU)]))
    expect(progress).toMatchObject({ legNumber: 2, legCount: 3, remainingNm: 200, remainingMinutes: 90 })
    expect(progress.next?.from.ident).toBe('KSAC')
  })
})

describe('readiness for the next leg', () => {
  const next = leg(KRIU, KSAC)
  const hangar = [parked('Comanche|', KRIU), parked('Cub|', KRNO)]

  it('is ready when the loaded aircraft sits at the start', () => {
    expect(readiness(next, live(), hangar)).toEqual({ kind: 'ready', aircraftName: 'Comanche' })
  })

  it('offers Restore when the loaded aircraft is elsewhere but parked at the start', () => {
    expect(readiness(next, live({ lat: KRNO.lat, lon: KRNO.lon }), hangar)).toEqual({ kind: 'restore', aircraftName: 'Comanche', aircraftKey: 'Comanche|' })
  })

  it('names what is parked at the start when the loaded aircraft lives elsewhere', () => {
    const result = readiness(next, live({ aircraftKey: 'Cub|', aircraftName: 'Cub', lat: KRNO.lat, lon: KRNO.lon, nearAirport: { ident: 'KRNO', name: 'Reno' } }), hangar)
    expect(result.kind).toBe('elsewhere')
    expect(result.kind === 'elsewhere' && result.parkedHere.map((r) => r.key)).toEqual(['Comanche|'])
    expect(result.kind === 'elsewhere' && result.here?.ident).toBe('KRNO')
  })

  it('shows distance to go in the air', () => {
    const result = readiness(next, live({ onGround: false, lat: KSAC.lat, lon: KSAC.lon + 0.5 }), hangar)
    expect(result.kind).toBe('flying')
    // Half a degree of longitude at 38.5° north.
    expect(result.kind === 'flying' && result.toGoNm).toBeCloseTo(23.5, 0)
  })

  it('still says what is parked at the start with the sim off', () => {
    const result = readiness(next, live({ connected: false, lat: null, lon: null, onGround: null }), hangar)
    expect(result).toEqual({ kind: 'offline', parkedHere: [hangar[0]] })
  })
})

describe('aircraft names', () => {
  it('adds the livery only when two aircraft would read the same', () => {
    const red = { ...parked('Comanche|Red', KRIU), snapshot: { ...parked('Comanche|Red', KRIU).snapshot, aircraft: { title: 'Comanche', livery: 'Red', atcId: '' } } }
    const blue = { ...parked('Comanche|Blue', KRIU), snapshot: { ...parked('Comanche|Blue', KRIU).snapshot, aircraft: { title: 'Comanche', livery: 'Blue', atcId: '' } } }
    const cub = parked('Cub|', KRNO)
    const labels = aircraftLabels([red, blue, cub])
    expect(labels.get('Comanche|Red')).toBe('Comanche (Red)')
    expect(labels.get('Comanche|Blue')).toBe('Comanche (Blue)')
    expect(labels.get('Cub|')).toBe('Cub')
    expect(aircraftLabels([{ ...red, nickname: 'Old Red' }, blue]).get('Comanche|Red')).toBe('Old Red')
  })
})
