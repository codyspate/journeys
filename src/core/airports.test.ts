import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_DESCENT, NO_LIMITS, PERFORMANCE_PRESETS } from '../shared/journey'
import { AirportIndex, airportsFromRows, type AirportRow } from './airports'
import { createJourney, editRoute } from './planner'

const rows = JSON.parse(readFileSync(join(process.cwd(), 'resources/airports.json'), 'utf8')) as AirportRow[]
const index = new AirportIndex(airportsFromRows(rows))

describe('the bundled airport list', () => {
  it('includes small strips with no runway on record', () => {
    expect(index.get('00AA')).toMatchObject({ name: 'Aero B Ranch Airport', runwayFt: 0 })
  })

  it('includes seaplane bases, without counting water as a runway', () => {
    const seaplane = index.all.filter((a) => /seaplane base/i.test(a.name))
    expect(seaplane.length).toBeGreaterThan(500)
    expect(index.all.find((a) => a.ident === 'US-1231')?.runwayFt).toBe(0)
  })

  it('finds an airport by the other codes it goes by', () => {
    expect(index.get('K5M6')?.ident).toBe('0MI1')
    expect(index.get('k5m6')?.ident).toBe('0MI1')
    expect(index.search('K5M6')[0].ident).toBe('0MI1')
  })

  it("keeps an airport's own ident ahead of another airport's alternate code", () => {
    expect(index.get('KRIU')?.name).toBe('Rancho Murieta Airport')
  })
})

describe('airports with no runway on record', () => {
  const comanche = { ...PERFORMANCE_PRESETS[0], minRunwayFt: 0 }
  const journey = createJourney(
    { name: '', originIdent: 'KSAN', destinationIdent: 'KBOS', performance: comanche, maxLegMinutes: 240, limits: NO_LIMITS, descent: DEFAULT_DESCENT },
    index,
    'j',
    0
  )

  it('are never picked by the planner, even with no minimum runway', () => {
    for (const leg of journey.legs.slice(0, -1)) expect(index.get(leg.to.ident)!.runwayFt).toBeGreaterThan(0)
  })

  it('can still be added as a stop, or found by another code', () => {
    const withStrip = editRoute(journey, { kind: 'add', ident: '00AA' }, index)
    expect(withStrip.legs.map((leg) => leg.to.ident)).toContain('00AA')
    const byCode = editRoute(journey, { kind: 'add', ident: 'K5M6' }, index)
    expect(byCode.legs.map((leg) => leg.to.ident)).toContain('0MI1')
  })
})
