import type { Airport, AirportSize } from '../shared/journey'
import { distanceNm } from './recorder'

/** The last field, other codes for the same airport, is missing from lists built before it existed. */
export type AirportRow = [string, string, number, number, number, number, string, string, number, number, number, string[]?]

const SIZES: AirportSize[] = ['small', 'medium', 'large']
const SIZE_RANK: Record<AirportSize, number> = { small: 0, medium: 1, large: 2 }

export function airportsFromRows(rows: AirportRow[]): Airport[] {
  return rows.map(([ident, name, lat, lon, elevationFt, size, city, country, runwayFt, hard, scheduled, codes]) => ({
    ident,
    name,
    lat,
    lon,
    elevationFt,
    size: SIZES[size],
    city,
    country,
    runwayFt,
    hardSurface: hard === 1,
    scheduled: scheduled === 1,
    codes: codes ?? []
  }))
}

export class AirportIndex {
  private readonly byIdent = new Map<string, Airport>()
  private readonly byOtherCode = new Map<string, Airport>()

  constructor(readonly all: Airport[]) {
    for (const airport of all) this.byIdent.set(airport.ident, airport)
    // An airport's own ident always wins over another airport's alternate code.
    for (const airport of all) for (const code of airport.codes ?? []) if (!this.byOtherCode.has(code)) this.byOtherCode.set(code, airport)
  }

  /** Finds an airport by its ident or any other code it goes by. */
  get(ident: string): Airport | undefined {
    const code = ident.trim().toUpperCase()
    return this.byIdent.get(code) ?? this.byOtherCode.get(code)
  }

  search(query: string, limit = 12): Airport[] {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return []
    const score = (a: Airport) => {
      const ident = a.ident.toLowerCase()
      const codes = (a.codes ?? []).map((code) => code.toLowerCase())
      if (ident === q || codes.includes(q)) return 0
      if (ident.startsWith(q) || codes.some((code) => code.startsWith(q))) return 1
      if (a.city.toLowerCase().startsWith(q)) return 2
      if (a.name.toLowerCase().includes(q) || a.city.toLowerCase().includes(q)) return 3
      return null
    }
    return this.all
      .map((airport) => ({ airport, rank: score(airport) }))
      .filter((entry): entry is { airport: Airport; rank: number } => entry.rank !== null)
      .sort((a, b) => a.rank - b.rank || SIZE_RANK[b.airport.size] - SIZE_RANK[a.airport.size])
      .slice(0, limit)
      .map((entry) => entry.airport)
  }

  nearest(lat: number, lon: number, withinNm: number): Airport | null {
    let best: Airport | null = null
    let bestDistance = withinNm
    for (const airport of this.all) {
      if (Math.abs(airport.lat - lat) * 60 > bestDistance) continue
      const distance = distanceNm(lat, lon, airport.lat, airport.lon)
      if (distance <= bestDistance) {
        best = airport
        bestDistance = distance
      }
    }
    return best
  }
}
