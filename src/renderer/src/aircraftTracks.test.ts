import { describe, expect, it } from 'vitest'
import type { AircraftFlight, LogbookFlight, TrackPoint } from '../../shared/logbook'
import { aircraftTracks, routeLabel } from './aircraftTracks'

const point = (lat: number, lon: number): TrackPoint => ({ t: 0, lat, lon, altFt: 0, aglFt: 0, gsKts: 0, onGround: false })
const landing = (lat: number, lon: number) => ({ t: 0, lat, lon, touchdownFpm: 100, maxG: 1, iasKts: 60, gsKts: 60, headwindKts: 0, crosswindKts: 0, bounces: 0 })

function flown(id: string, track: TrackPoint[], overrides: Partial<LogbookFlight> = {}, idents: [string | null, string | null] = ['KAAA', 'KBBB']): AircraftFlight {
  const flight: LogbookFlight = {
    id,
    aircraft: { title: 'Comanche', livery: 'Red', atcId: '' },
    status: 'complete',
    startedAt: 0,
    takeoffAt: 60_000,
    landedAt: 3_660_000,
    endedAt: 3_700_000,
    origin: { lat: track[0]?.lat ?? 0, lon: track[0]?.lon ?? 0 },
    destination: null,
    startedAirborne: false,
    distanceNm: 100,
    maxAltitudeFt: 5000,
    maxG: 1.2,
    fuelStartGal: 50,
    fuelEndGal: 40,
    landings: [landing(track.at(-1)?.lat ?? 0, track.at(-1)?.lon ?? 0)],
    events: [],
    ...overrides
  }
  return { flight, fromIdent: idents[0], toIdent: idents[1], track }
}

describe('aircraftTracks', () => {
  const history = [flown('a', [point(38, -121), point(39, -120)]), flown('b', [point(39, -120), point(40, -118)])]

  it('draws one line per flight and a dot per landing', () => {
    const tracks = aircraftTracks(history)
    expect(tracks.lines.features.map((f) => f.properties.id)).toEqual(['a', 'b'])
    expect(tracks.landings.features).toHaveLength(2)
  })

  it('frames every flight', () => {
    expect(aircraftTracks(history).bounds).toEqual([
      [-121, 38],
      [-118, 40]
    ])
  })

  it('adds up time, distance and landings', () => {
    expect(aircraftTracks(history).totals).toEqual({ flights: 2, airMinutes: 120, distanceNm: 200, landings: 2 })
  })

  it('still counts flights with no usable path, without drawing them', () => {
    const tracks = aircraftTracks([...history, flown('c', [point(0, 0)])])
    expect(tracks.lines.features).toHaveLength(2)
    expect(tracks.totals.flights).toBe(3)
  })

  it('has nothing to frame with no paths', () => {
    expect(aircraftTracks([]).bounds).toBeNull()
  })

  it('keeps a Pacific crossing continuous', () => {
    const tracks = aircraftTracks([flown('p', [point(21, 179), point(22, -179)])])
    expect(tracks.lines.features[0].geometry.coordinates[1][0]).toBe(181)
    expect(tracks.landings.features[0].geometry.coordinates[0]).toBe(181)
  })
})

describe('routeLabel', () => {
  it('names both airports', () => {
    expect(routeLabel(flown('a', [point(38, -121)]))).toBe('KAAA → KBBB')
  })

  it('says when a flight started in the air or never landed', () => {
    expect(routeLabel(flown('a', [point(38, -121)], { startedAirborne: true, landings: [], status: 'interrupted' }, [null, null]))).toBe(
      'In the air → Not landed'
    )
  })
})
