import { distanceNm } from './recorder'

export interface LatLon {
  lat: number
  lon: number
}

export interface TerrainProfile {
  /** Highest ground under the direct line, in feet. */
  highestFt: number
  /** Longest unbroken stretch over water, in nautical miles. */
  longestWaterNm: number
}

/** Lets a walk stop early once the answer is already known to be "too high" or "too wet". */
export interface GiveUp {
  aboveFt: number
  waterNm: number
}

export interface Terrain {
  profile(from: LatLon, to: LatLon, giveUp?: GiveUp): TerrainProfile
}

const MAGIC = 'JTR1'
const HEADER_BYTES = 16
const STEP_NM = 2
const toRad = Math.PI / 180

/** Points along the great circle from a to b, about every STEP_NM. */
export function* alongGreatCircle(a: LatLon, b: LatLon, stepNm = STEP_NM): Generator<LatLon & { stepNm: number }> {
  const total = distanceNm(a.lat, a.lon, b.lat, b.lon)
  const steps = Math.max(1, Math.ceil(total / stepNm))
  const [φ1, λ1, φ2, λ2] = [a.lat * toRad, a.lon * toRad, b.lat * toRad, b.lon * toRad]
  const δ = total / 3440.065
  const x1 = Math.cos(φ1) * Math.cos(λ1)
  const y1 = Math.cos(φ1) * Math.sin(λ1)
  const z1 = Math.sin(φ1)
  const x2 = Math.cos(φ2) * Math.cos(λ2)
  const y2 = Math.cos(φ2) * Math.sin(λ2)
  const z2 = Math.sin(φ2)
  for (let i = 0; i <= steps; i++) {
    const f = i / steps
    const [p, q] = δ < 1e-9 ? [1 - f, f] : [Math.sin((1 - f) * δ) / Math.sin(δ), Math.sin(f * δ) / Math.sin(δ)]
    const x = p * x1 + q * x2
    const y = p * y1 + q * y2
    const z = p * z1 + q * z2
    yield { lat: Math.atan2(z, Math.hypot(x, y)) / toRad, lon: Math.atan2(y, x) / toRad, stepNm: i === 0 ? 0 : total / steps }
  }
}

/**
 * A world grid of the highest ground in each cell and whether the cell is water.
 * Rows run from 90°N southwards, columns from 180°W eastwards.
 */
export class TerrainGrid implements Terrain {
  readonly cellDeg: number

  constructor(
    readonly cols: number,
    readonly rows: number,
    private readonly elevationsFt: Int16Array,
    private readonly water: Uint8Array
  ) {
    if (cols !== rows * 2 || elevationsFt.length !== cols * rows) throw new Error('Terrain grid has the wrong shape.')
    this.cellDeg = 180 / rows
  }

  /** Reads the format written by scripts/build-terrain.py, after it has been unzipped. */
  static fromBytes(bytes: Uint8Array): TerrainGrid {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) throw new Error('Not a Journeys terrain file.')
    const cols = view.getUint32(4, true)
    const rows = view.getUint32(8, true)
    const cells = cols * rows
    const elevations = new Int16Array(cells)
    for (let i = 0; i < cells; i++) elevations[i] = view.getInt16(HEADER_BYTES + i * 2, true)
    const waterStart = HEADER_BYTES + cells * 2
    return new TerrainGrid(cols, rows, elevations, bytes.slice(waterStart, waterStart + Math.ceil(cells / 8)))
  }

  private cell({ lat, lon }: LatLon): number {
    const row = Math.min(this.rows - 1, Math.max(0, Math.floor((90 - lat) / this.cellDeg)))
    const col = (((Math.floor((lon + 180) / this.cellDeg) % this.cols) + this.cols) % this.cols)
    return row * this.cols + col
  }

  elevationFt(point: LatLon): number {
    return this.elevationsFt[this.cell(point)]
  }

  isWater(point: LatLon): boolean {
    const i = this.cell(point)
    return (this.water[i >> 3] & (1 << (i & 7))) !== 0
  }

  profile(from: LatLon, to: LatLon, giveUp?: GiveUp): TerrainProfile {
    // Walks the chord between the two unit vectors and projects back onto the sphere: the same
    // points as a great circle to well within a grid cell, without per-step sines.
    const [φ1, λ1, φ2, λ2] = [from.lat * toRad, from.lon * toRad, to.lat * toRad, to.lon * toRad]
    const x1 = Math.cos(φ1) * Math.cos(λ1)
    const y1 = Math.cos(φ1) * Math.sin(λ1)
    const z1 = Math.sin(φ1)
    const dx = Math.cos(φ2) * Math.cos(λ2) - x1
    const dy = Math.cos(φ2) * Math.sin(λ2) - y1
    const dz = Math.sin(φ2) - z1
    const total = distanceNm(from.lat, from.lon, to.lat, to.lon)
    const steps = Math.max(1, Math.ceil(total / STEP_NM))
    const stepNm = total / steps
    const { rows, cols, cellDeg, elevationsFt, water } = this
    const perRadian = 1 / (cellDeg * toRad)

    let highestFt = 0
    let longestWaterNm = 0
    let waterNm = 0
    for (let i = 0; i <= steps; i++) {
      const f = i / steps
      const x = x1 + dx * f
      const y = y1 + dy * f
      const z = z1 + dz * f
      const row = Math.min(rows - 1, Math.max(0, Math.floor((Math.PI / 2 - Math.atan2(z, Math.hypot(x, y))) * perRadian)))
      const col = Math.floor((Math.atan2(y, x) + Math.PI) * perRadian) % cols
      const cell = row * cols + col
      if (elevationsFt[cell] > highestFt) highestFt = elevationsFt[cell]
      waterNm = water[cell >> 3] & (1 << (cell & 7)) ? waterNm + (i === 0 ? 0 : stepNm) : 0
      if (waterNm > longestWaterNm) longestWaterNm = waterNm
      if (giveUp && (highestFt > giveUp.aboveFt || longestWaterNm > giveUp.waterNm)) break
    }
    return { highestFt, longestWaterNm }
  }
}
