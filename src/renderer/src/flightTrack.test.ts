import { describe, expect, it } from 'vitest'
import type { TrackPoint } from '../../shared/logbook'
import { buildTrack, gradientExpression, nearestPoint, RAMP, rampColor } from './flightTrack'

const point = (t: number, lat: number, lon: number, altFt: number, aglFt: number, gsKts: number): TrackPoint => ({
  t,
  lat,
  lon,
  altFt,
  aglFt,
  gsKts,
  onGround: aglFt < 5
})

describe('buildTrack', () => {
  const points = [point(0, 38, -121, 100, 0, 0), point(1, 38.1, -121, 3000, 2900, 120), point(2, 38.2, -121, 5000, 4000, 150)]

  it('draws the whole flight as one line', () => {
    const track = buildTrack(points)!
    expect(track.line.geometry.coordinates).toHaveLength(3)
    expect(track.points.map((p) => p.progress)).toEqual([0, 0.5, 1])
  })

  it('finds the range of each measure', () => {
    const { domain } = buildTrack(points)!
    expect(domain.altFt).toEqual([100, 5000])
    expect(domain.gsKts).toEqual([0, 150])
  })

  it('never shows height above ground below zero', () => {
    const track = buildTrack([point(0, 38, -121, 0, -12, 0), point(1, 38.1, -121, 0, -12, 0)])!
    expect(track.domain.aglFt[0]).toBe(0)
  })

  it('gives a flat flight a usable range', () => {
    const level = buildTrack([point(0, 38, -121, 5000, 4000, 120), point(1, 38.1, -121, 5000, 4000, 120)])!
    expect(level.domain.altFt).toEqual([5000, 5001])
  })

  it('skips points with no position, and needs at least two', () => {
    expect(buildTrack([point(0, 0, 0, 0, 0, 0), point(1, 38, -121, 0, 0, 0)])).toBeNull()
    expect(buildTrack([point(0, 0, 0, 0, 0, 0), ...points])!.points).toHaveLength(3)
  })

  it('stays continuous across the date line', () => {
    const track = buildTrack([point(0, 50, 179.5, 0, 0, 0), point(1, 50, -179.5, 0, 0, 0)])!
    expect(track.line.geometry.coordinates[1][0]).toBe(180.5)
  })

  it('marks the start, each landing and the end', () => {
    const landing = { t: 2, lat: 38.2, lon: -121, touchdownFpm: 120, maxG: 1.2, iasKts: 60, gsKts: 60, headwindKts: 0, crosswindKts: 0, bounces: 0 }
    expect(buildTrack(points, [landing])!.marks.features.map((f) => f.properties.kind)).toEqual(['start', 'landing', 'end'])
  })
})

describe('colouring', () => {
  it('runs the ramp from low to high', () => {
    expect(rampColor(0, [0, 300])).toBe(RAMP[0])
    expect(rampColor(300, [0, 300])).toBe(RAMP.at(-1))
    expect(rampColor(100, [0, 300])).toBe(RAMP[1])
    expect(rampColor(-50, [0, 300])).toBe(RAMP[0])
  })

  it('builds a gradient with strictly increasing stops, even with time parked', () => {
    const parked = [point(0, 38, -121, 0, 0, 0), point(1, 38, -121, 0, 0, 0), point(2, 38.1, -121, 3000, 3000, 120), point(3, 38.2, -121, 6000, 6000, 150)]
    const expression = gradientExpression(buildTrack(parked)!, 'altFt')
    expect(expression.slice(0, 3)).toEqual(['interpolate', ['linear'], ['line-progress']])
    const positions = expression.slice(3).filter((_, i) => i % 2 === 0) as number[]
    expect(positions[0]).toBe(0)
    expect(positions.at(-1)).toBe(1)
    positions.slice(1).forEach((p, i) => expect(p).toBeGreaterThan(positions[i]))
  })

  it('keeps the gradient a manageable size for long flights', () => {
    const long = Array.from({ length: 10_000 }, (_, i) => point(i, 30 + i * 0.001, -100, i, i, 120))
    expect(gradientExpression(buildTrack(long)!, 'altFt').length).toBeLessThan(1000)
  })
})

it('finds the recorded point nearest the mouse', () => {
  const track = buildTrack([point(0, 38, -121, 100, 0, 0), point(1, 38.1, -121, 3000, 2900, 120), point(2, 38.2, -121, 5000, 4000, 150)])!
  expect(nearestPoint(track, -121.01, 38.09).altFt).toBe(3000)
})
