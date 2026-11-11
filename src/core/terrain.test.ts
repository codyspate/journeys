import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { alongGreatCircle, TerrainGrid } from './terrain'
import { distanceNm } from './recorder'

/** A 1-degree world: flat land, one 9,000 ft cell just south of 40°N 105°W, and water east of 0°. */
function tinyWorld(): TerrainGrid {
  const cols = 360
  const rows = 180
  const elevations = new Int16Array(cols * rows)
  const water = new Uint8Array(Math.ceil((cols * rows) / 8))
  elevations[(90 - 40) * cols + (180 - 105)] = 9000
  for (let row = 0; row < rows; row++) {
    for (let col = 180; col < cols; col++) {
      const i = row * cols + col
      water[i >> 3] |= 1 << (i & 7)
    }
  }
  return new TerrainGrid(cols, rows, elevations, water)
}

describe('terrain grid', () => {
  const world = tinyWorld()

  it('walks the great circle in small, even steps', () => {
    const points = [...alongGreatCircle({ lat: 40, lon: -110 }, { lat: 40, lon: -100 })]
    const walked = points.reduce((sum, p) => sum + p.stepNm, 0)
    expect(walked).toBeCloseTo(distanceNm(40, -110, 40, -100), 3)
    expect(Math.max(...points.map((p) => p.stepNm))).toBeLessThanOrEqual(2)
    // A great circle between two points on the same parallel bulges towards the pole.
    expect(Math.max(...points.map((p) => p.lat))).toBeGreaterThan(40.05)
  })

  it('finds the high ground under a leg, and nothing beside it', () => {
    expect(world.profile({ lat: 39.5, lon: -110 }, { lat: 39.5, lon: -100 }).highestFt).toBe(9000)
    expect(world.profile({ lat: 36, lon: -110 }, { lat: 36, lon: -100 }).highestFt).toBe(0)
  })

  it('measures the longest stretch over water', () => {
    const { longestWaterNm } = world.profile({ lat: 0, lon: -1 }, { lat: 0, lon: 3 })
    expect(longestWaterNm).toBeGreaterThan(175)
    expect(longestWaterNm).toBeLessThan(185)
    expect(world.profile({ lat: 0, lon: -3 }, { lat: 0, lon: -1 }).longestWaterNm).toBe(0)
  })

  it('reads its own file format', () => {
    const header = new Uint8Array(16)
    header.set(new TextEncoder().encode('JTR1'))
    new DataView(header.buffer).setUint32(4, 4, true)
    new DataView(header.buffer).setUint32(8, 2, true)
    const body = new Uint8Array(8 * 2 + 1)
    new DataView(body.buffer).setInt16(2, 1234, true)
    body[16] = 0b10
    const grid = TerrainGrid.fromBytes(new Uint8Array([...header, ...body]))
    expect(grid.elevationFt({ lat: 45, lon: -45 })).toBe(1234)
    expect(grid.isWater({ lat: 45, lon: -45 })).toBe(true)
    expect(grid.isWater({ lat: 45, lon: -135 })).toBe(false)
    expect(() => TerrainGrid.fromBytes(new Uint8Array(32))).toThrow('Not a Journeys terrain file')
  })
})

describe('the bundled world terrain', () => {
  const world = TerrainGrid.fromBytes(gunzipSync(readFileSync(join(process.cwd(), 'resources/terrain.bin.gz'))))

  it('knows the big mountains and the sea', () => {
    expect(world.elevationFt({ lat: 27.988, lon: 86.925 })).toBeGreaterThan(27000) // Everest
    expect(world.elevationFt({ lat: 39.118, lon: -106.445 })).toBeGreaterThan(13500) // Mount Elbert
    expect(world.isWater({ lat: 30, lon: -140 })).toBe(true)
    expect(world.isWater({ lat: 39, lon: -100 })).toBe(false)
    expect(world.isWater({ lat: 43.5, lon: -87 })).toBe(true) // Lake Michigan
  })

  it('profiles real legs', () => {
    expect(world.profile({ lat: 39.57, lon: -104.85 }, { lat: 40.79, lon: -111.98 }).highestFt).toBeGreaterThan(11000) // Denver to Salt Lake City
    expect(world.profile({ lat: 32.73, lon: -117.19 }, { lat: 21.32, lon: -157.92 }).longestWaterNm).toBeGreaterThan(2000) // San Diego to Honolulu
  })
})
