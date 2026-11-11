import { describe, expect, it } from 'vitest'
import { DEFAULT_DESCENT, type Journey, type Leg, NO_LIMITS, type Stop } from '../../shared/journey'
import { journeyMapData, unwrapLongitudes } from './mapData'

const stop = (ident: string, lat: number, lon: number): Stop => ({ ident, name: ident, lat, lon })

const leg = (from: Stop, to: Stop, status: Leg['status'], confidence: Leg['confidence'] = 'firm'): Leg => ({
  id: `${from.ident}-${to.ident}`,
  from,
  to,
  status,
  distanceNm: 100,
  minutes: 60,
  fuelGal: 10,
  beyondRange: false,
  beyondSession: false,
  pinned: false,
  confidence,
  flightId: null,
  aircraft: null
})

const a = stop('A', 30, -120)
const b = stop('B', 35, -110)
const c = stop('C', 40, -100)

function journey(legs: Leg[], status: Journey['status'] = 'active'): Journey {
  return {
    id: 'j',
    name: 'Test',
    createdAt: 0,
    lastOpenedAt: 0,
    status,
    origin: a,
    destination: c,
    via: [],
    avoid: [],
    performance: { name: 'x', cruiseKts: 100, burnGph: 10, usableFuelGal: 50, reserveMinutes: 45, minRunwayFt: 1000, needsHardSurface: false },
    maxLegMinutes: 120,
    limits: NO_LIMITS,
    descent: DEFAULT_DESCENT,
    legs
  }
}

describe('unwrapLongitudes', () => {
  it('leaves ordinary routes alone', () => {
    expect(unwrapLongitudes([-120, -110, -100])).toEqual([-120, -110, -100])
  })

  it('stays continuous across the date line in both directions', () => {
    expect(unwrapLongitudes([170, -175])).toEqual([170, 185])
    expect(unwrapLongitudes([-175, 170])).toEqual([-175, -190])
  })
})

describe('journeyMapData', () => {
  it('styles each leg by its status', () => {
    const data = journeyMapData(journey([leg(a, b, 'flown'), leg(b, c, 'planned', 'tentative')]))
    expect(data.lines.features.map((f) => f.properties.status)).toEqual(['flown', 'tentative'])
  })

  it('highlights where the pilot is now', () => {
    const data = journeyMapData(journey([leg(a, b, 'flown'), leg(b, c, 'planned')]))
    expect(data.stops.features.map((f) => f.properties.kind)).toEqual(['endpoint', 'current', 'endpoint'])
  })

  it('shows the origin as current before anything is flown', () => {
    expect(journeyMapData(journey([leg(a, b, 'planned')])).stops.features[0].properties.kind).toBe('current')
  })

  it('shows no current stop on a finished Journey', () => {
    const data = journeyMapData(journey([leg(a, b, 'flown'), leg(b, c, 'flown')], 'complete'))
    expect(data.stops.features.some((f) => f.properties.kind === 'current')).toBe(false)
  })

  it('lets only unflown stops be dragged', () => {
    const roles = (j: Journey) => journeyMapData(j).stops.features.map((f) => f.properties.role)
    expect(roles(journey([leg(a, b, 'planned'), leg(b, c, 'planned')]))).toEqual(['origin', 'stop', 'destination'])
    expect(roles(journey([leg(a, b, 'flown'), leg(b, c, 'planned')]))).toEqual([null, null, 'destination'])
    expect(roles(journey([leg(a, b, 'flown'), leg(b, c, 'flown')], 'complete'))).toEqual([null, null, null])
  })

  it('bounds every stop', () => {
    expect(journeyMapData(journey([leg(a, b, 'planned'), leg(b, c, 'planned')])).bounds).toEqual([
      [-120, 30],
      [-100, 40]
    ])
  })
})
