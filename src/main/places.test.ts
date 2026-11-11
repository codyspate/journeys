import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AirportIndex } from '../core/airports'
import type { Airport } from '../shared/journey'
import { PlaceStore } from './places'

const airport = (ident: string, name: string, codes: string[] = []): Airport => ({
  ident,
  name,
  lat: 38,
  lon: -121,
  elevationFt: 0,
  size: 'small',
  city: 'Somewhere',
  country: 'US',
  runwayFt: 3000,
  hardSurface: true,
  scheduled: false,
  codes
})
const index = new AirportIndex([airport('KRIU', 'Rancho Murieta'), airport('0MI1', 'Sugar Springs', ['K5M6'])])
const store = () => new PlaceStore(join(mkdtempSync(join(tmpdir(), 'journeys-places-')), 'logbook.db'), index)

describe('your places', () => {
  it('pins an airport by any of its codes', () => {
    const places = store()
    expect(places.add('k5m6', 'want', '')).toMatchObject({ ident: '0MI1', name: 'Sugar Springs', kind: 'want' })
    expect(places.list().map((p) => p.ident)).toEqual(['0MI1'])
  })

  it('re-pinning changes how it is marked instead of adding it twice', () => {
    const places = store()
    places.add('KRIU', 'want', '')
    places.add('KRIU', 'home', 'Where it all started')
    expect(places.list()).toHaveLength(1)
    expect(places.list()[0]).toMatchObject({ kind: 'home', note: 'Where it all started' })
  })

  it('removes a pin, and explains an unknown airport', () => {
    const places = store()
    const pin = places.add('KRIU', 'been', '')
    places.remove(pin.id)
    expect(places.list()).toEqual([])
    expect(() => places.add('ZZZZ', 'want', '')).toThrow("Couldn't find an airport called ZZZZ.")
  })
})
