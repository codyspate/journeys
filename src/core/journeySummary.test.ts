import { describe, expect, it } from 'vitest'
import type { Journey, Leg, Stop } from '../shared/journey'
import { NO_LIMITS, PERFORMANCE_PRESETS } from '../shared/journey'
import type { LogbookFlight } from '../shared/logbook'
import { journeySummary } from './journeySummary'

// On the equator, so one degree of longitude is 60 nm.
const stop = (ident: string, lon: number): Stop => ({ ident, name: ident, lat: 0, lon })
const A = stop('AAAA', 0)
const B = stop('BBBB', 2)
const C = stop('CCCC', 4)
const COUNTRY: Record<string, string> = { AAAA: 'US', BBBB: 'US', CCCC: 'CA' }
const DAY = 86_400_000
const START = new Date(2026, 10, 1, 9).getTime()

const flight = (id: string, takeoffAt: number, touchdownFpm: number, extra: Partial<LogbookFlight> = {}): LogbookFlight => ({
  id,
  aircraft: { title: 'Comanche', livery: 'Red' } as LogbookFlight['aircraft'],
  status: 'complete',
  startedAt: takeoffAt - 600_000,
  takeoffAt,
  landedAt: takeoffAt + 3_600_000,
  endedAt: takeoffAt + 4_000_000,
  origin: { lat: 0, lon: 0 },
  destination: { lat: 0, lon: 0 },
  startedAirborne: false,
  distanceNm: 120,
  maxAltitudeFt: 6500,
  maxG: 1.3,
  fuelStartGal: 60,
  fuelEndGal: 46,
  landings: [{ t: takeoffAt + 3_600_000, lat: 0, lon: 0, touchdownFpm, maxG: 1.2, iasKts: 70, gsKts: 70, headwindKts: 0, crosswindKts: 0, bounces: 0 }],
  events: [],
  ...extra
})

const leg = (from: Stop, to: Stop, flightId: string, distanceNm: number): Leg => ({
  id: `flown-${flightId}`,
  from,
  to,
  status: 'flown',
  distanceNm,
  minutes: 60,
  fuelGal: 14,
  beyondRange: false,
  beyondSession: false,
  pinned: false,
  confidence: 'firm',
  flightId,
  aircraft: 'Comanche'
})

const journey: Journey = {
  id: 'j',
  name: 'Test',
  createdAt: START,
  lastOpenedAt: START,
  status: 'complete',
  origin: A,
  destination: C,
  via: [],
  avoid: [],
  performance: PERFORMANCE_PRESETS[0],
  maxLegMinutes: 120,
  limits: NO_LIMITS,
  legs: [leg(A, B, 'f1', 120), leg(B, C, 'f2', 180)]
}

const flights = [
  flight('f1', START, 240, { maxAltitudeFt: 8500, events: [{ t: 0, type: 'stall', value: 1 }] }),
  flight('f2', START + 2 * DAY, 80, { maxG: 1.8 })
]
const input = {
  flights: new Map(flights.map((f) => [f.id, f])),
  countryOf: (ident: string) => COUNTRY[ident] ?? null,
  journals: { f1: { note: 'Nice view', photoCount: 3 }, f2: { note: '', photoCount: 1 } }
}

describe('journeySummary', () => {
  it('adds up the legs flown and picks out the highlights', () => {
    const summary = journeySummary(journey, input)
    expect(summary).toMatchObject({
      legs: 2,
      distanceNm: 300,
      directNm: 240,
      airMinutes: 120,
      fuelGal: 28,
      landings: 2,
      airports: 3,
      countries: ['US', 'CA'],
      aircraft: ['Comanche'],
      softest: { ident: 'CCCC', touchdownFpm: 80 },
      firmest: { ident: 'BBBB', touchdownFpm: 240 },
      highestFt: 8500,
      longestLeg: { from: 'BBBB', to: 'CCCC', distanceNm: 180 },
      shortestLeg: { from: 'AAAA', to: 'BBBB', distanceNm: 120 },
      maxG: 1.8,
      stallWarnings: 1,
      photos: 4,
      notes: 1,
      title: 'Border hopper'
    })
    expect(summary.funFacts).toContain('Spread over 3 days on the calendar.')
    expect(summary.funFacts.some((fact) => fact.includes('bathtubs'))).toBe(true)
  })

  it("still sums the legs when their flights have left the logbook", () => {
    const summary = journeySummary(journey, { ...input, flights: new Map(), journals: {} })
    expect(summary).toMatchObject({ distanceNm: 300, landings: 0, softest: null, highestFt: null, startedAt: null })
  })

  it('calls out a long way round', () => {
    const roundabout = { ...journey, destination: B, legs: [leg(A, C, 'f1', 120), leg(C, B, 'f2', 120)] }
    const summary = journeySummary(roundabout, { ...input, countryOf: () => 'US' })
    expect(summary.title).toBe('Scenic-route specialist')
    expect(summary.funFacts[0]).toBe('You flew 2× the straight line. The scenic route, clearly.')
  })
})
