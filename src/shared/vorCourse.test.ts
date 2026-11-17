import { describe, expect, it } from 'vitest'
import type { Stop, VorFix } from './journey'
import { formatCourse, magnetic, routeSegments } from './vorCourse'

// On the equator one degree of longitude is 60 nm, and due east is 090° true.
const airport = (ident: string, lat: number, lon: number): Stop => ({ ident, name: ident, lat, lon })
const fix = (ident: string, lat: number, lon: number, magVarDeg = 0): VorFix => ({
  ident,
  name: ident,
  type: 'VORTAC',
  freqMhz: 114.1,
  lat,
  lon,
  magVarDeg
})

describe('magnetic', () => {
  it('subtracts east variation and adds west', () => {
    expect(magnetic(90, 10)).toBe(80)
    expect(magnetic(90, -15)).toBe(105)
  })

  it('wraps round and calls north 360', () => {
    expect(magnetic(5, 10)).toBe(355)
    expect(magnetic(355, -5)).toBe(360)
    expect(formatCourse(45)).toBe('045°')
  })
})

describe('routeSegments', () => {
  const leg = {
    from: airport('AAA', 0, 0),
    to: airport('BBB', 0, 3),
    vorRoute: [fix('V1', 0, 1, 10), fix('V2', 0, 2, -5)]
  }

  it('gives the course into the first VOR, radials out of each, and distances', () => {
    const segments = routeSegments(leg)
    expect(segments.map((s) => [s.from.ident, s.to.ident, s.outboundRadial, s.inboundCourse, Math.round(s.distanceNm)])).toEqual([
      ['AAA', 'V1', null, 80, 60],
      ['V1', 'V2', 80, 95, 60],
      ['V2', 'BBB', 95, null, 60]
    ])
  })

  it('leaves out the stretch to or from a VOR on the airport itself', () => {
    const onField = { ...leg, vorRoute: [fix('V0', 0, 0.005), ...leg.vorRoute, fix('V3', 0, 2.995)] }
    expect(routeSegments(onField).map((s) => `${s.from.ident}-${s.to.ident}`)).toEqual(['V0-V1', 'V1-V2', 'V2-V3'])
  })

  it('has nothing for a leg without a route', () => {
    expect(routeSegments({ ...leg, vorRoute: null })).toEqual([])
    expect(routeSegments({ ...leg, vorRoute: undefined })).toEqual([])
  })
})
