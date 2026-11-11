import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AirportIndex } from '../core/airports'
import { DEFAULT_DESCENT, type Airport, type Journey, NO_LIMITS } from '../shared/journey'
import type { LogbookFlight, TelemetrySample } from '../shared/logbook'
import { type AssistantSources, runTool, TOOLS } from './assistant'

const airport = (ident: string, name: string, lat: number, lon: number): Airport => ({
  ident,
  name,
  lat,
  lon,
  elevationFt: 1000,
  size: 'small',
  city: name,
  country: 'US',
  runwayFt: 3000,
  hardSurface: true,
  scheduled: false
})
const O22 = airport('O22', 'Columbia', 38.0304, -120.4146)
const KTRM = airport('KTRM', 'Jacqueline Cochran', 33.6267, -116.1597)
const KRIU = airport('KRIU', 'Rancho Murieta', 38.4868, -121.1028)

const sample = { t: 0, lat: 38.0, lon: -120.45, altFt: 11758, aglFt: 10218, gsKts: 145, iasKts: 118, headingTrue: 139, vsFpm: -1, onGround: 0, fuelGal: 83.1, windKts: 12, windDirTrue: 270, pauseFlags: 0 } as unknown as TelemetrySample

const journey: Journey = {
  id: 'j',
  name: 'Rancho Murieta to Thermal',
  createdAt: 0,
  lastOpenedAt: 1,
  status: 'active',
  origin: KRIU,
  destination: KTRM,
  via: [],
  avoid: [],
  performance: { name: 'A2A Comanche 250', cruiseKts: 160, burnGph: 14, usableFuelGal: 60, reserveMinutes: 45, minRunwayFt: 2000, needsHardSurface: false },
  maxLegMinutes: 240,
  limits: NO_LIMITS,
  descent: DEFAULT_DESCENT,
  legs: [
    { id: 'l1', from: KRIU, to: KTRM, status: 'planned', distanceNm: 378, minutes: 142, fuelGal: 33, beyondRange: false, beyondSession: false, pinned: false, confidence: 'firm', flightId: null, aircraft: null }
  ]
}

const flight = {
  id: 'f1',
  aircraft: { title: 'Comanche', livery: 'N7791P', atcId: '' },
  status: 'complete',
  startedAt: Date.UTC(2026, 10, 9),
  takeoffAt: Date.UTC(2026, 10, 9, 0, 1),
  landedAt: Date.UTC(2026, 10, 9, 0, 31),
  endedAt: Date.UTC(2026, 10, 9, 0, 33),
  origin: { lat: KRIU.lat, lon: KRIU.lon },
  destination: { lat: O22.lat, lon: O22.lon },
  startedAirborne: false,
  distanceNm: 45.2,
  maxAltitudeFt: 6500,
  maxG: 1.3,
  fuelStartGal: 86,
  fuelEndGal: 79,
  landings: [{ t: Date.UTC(2026, 10, 9, 0, 31), lat: O22.lat, lon: O22.lon, touchdownFpm: 140.4, maxG: 1.21, iasKts: 70, gsKts: 68, headwindKts: 6, crosswindKts: 3, bounces: 0 }],
  events: []
} as LogbookFlight

function sources(overrides: Partial<AssistantSources> = {}): AssistantSources {
  return {
    connected: () => true,
    lastSample: () => sample,
    aircraftName: () => 'Comanche',
    airports: new AirportIndex([O22, KTRM, KRIU]),
    journeys: () => [journey],
    flights: () => [flight],
    journals: () => ({ f1: { note: 'Smooth landing at Columbia.', photoCount: 2 } }),
    airframes: () => [],
    places: () => [],
    ...overrides
  }
}

describe('assistant tools', () => {
  it('describes the current flight, the nearest airport and the way to the next stop', () => {
    const result = runTool(sources(), 'get_current_flight', {}) as Record<string, any>
    expect(result).toMatchObject({ sim: 'running', aircraft: 'Comanche', altitude_ft_msl: 11758, heading_true: 139 })
    expect(result.nearest_airport).toMatchObject({ ident: 'O22', name: 'Columbia' })
    expect(result.journey.next_leg).toMatchObject({ from: 'KRIU', to: 'KTRM' })
    expect(result.journey.bearing_to_next_stop_true).toBeGreaterThan(120)
    expect(result.journey.bearing_to_next_stop_true).toBeLessThan(150)
  })

  it('says plainly when the sim is off or in a menu', () => {
    expect(runTool(sources({ connected: () => false }), 'get_current_flight', {})).toMatchObject({ sim: 'not running' })
    const menu = { ...sample, lat: 0, lon: 90 } as TelemetrySample
    expect(runTool(sources({ lastSample: () => menu }), 'get_current_flight', {})).toMatchObject({ sim: 'connected' })
  })

  it('finds airports around the aircraft or any point', () => {
    const near = runTool(sources(), 'find_airports_nearby', { radius_nm: 20 }) as { airports: { ident: string }[] }
    expect(near.airports.map((a) => a.ident)).toEqual(['O22'])
    const far = runTool(sources(), 'find_airports_nearby', { lat: 33.6, lon: -116.2, radius_nm: 10 }) as { airports: { ident: string }[] }
    expect(far.airports.map((a) => a.ident)).toEqual(['KTRM'])
  })

  it('summarises the logbook with airports, times and notes', () => {
    const [entry] = runTool(sources(), 'get_logbook', {}) as Record<string, unknown>[]
    expect(entry).toMatchObject({ id: 'f1', from: 'KRIU', to: 'O22', air_minutes: 30, last_touchdown_fpm: 140, note: 'Smooth landing at Columbia.', photos: 2 })
  })

  it('gives one flight in detail, and explains an unknown id', () => {
    const detail = runTool(sources(), 'get_flight', { flight_id: 'f1' }) as Record<string, any>
    expect(detail.landings[0]).toMatchObject({ airport: 'O22', touchdown_fpm: 140, headwind_kt: 6 })
    expect(() => runTool(sources(), 'get_flight', { flight_id: 'nope' })).toThrow('Use get_logbook')
    expect(() => runTool(sources(), 'fly_the_plane', {})).toThrow('no tool called')
  })

  it('keeps the MCP server’s own copy of the tool list in step with the app', () => {
    const copy = JSON.parse(readFileSync(join(process.cwd(), 'mcp', 'tools.json'), 'utf8'))
    expect(copy).toEqual(TOOLS)
  })
})
