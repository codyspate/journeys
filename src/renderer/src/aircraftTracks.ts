import type { FeatureCollection, LineString, Point } from 'geojson'
import { type AircraftFlight, airMinutes as flightAirMinutes, isRealPosition } from '../../shared/logbook'
import { unwrapLongitudes } from './mapData'

export interface AircraftTracks {
  lines: FeatureCollection<LineString, { id: string }>
  landings: FeatureCollection<Point, { id: string }>
  bounds: [[number, number], [number, number]] | null
  totals: { flights: number; airMinutes: number; distanceNm: number; landings: number }
}

const hasPosition = (p: { lat: number; lon: number }) => isRealPosition(p.lat, p.lon)

/** Every flight as one line each, for drawing an aircraft's whole history at once. */
export function aircraftTracks(flights: AircraftFlight[]): AircraftTracks {
  const lines: AircraftTracks['lines']['features'] = []
  const landings: AircraftTracks['landings']['features'] = []
  const lons: number[] = []
  const lats: number[] = []

  for (const { flight, track } of flights) {
    const points = track.filter(hasPosition)
    if (points.length < 2) continue
    const unwrapped = unwrapLongitudes(points.map((p) => p.lon))
    lines.push({
      type: 'Feature',
      properties: { id: flight.id },
      geometry: { type: 'LineString', coordinates: points.map((p, i) => [unwrapped[i], p.lat]) }
    })
    lons.push(...unwrapped)
    lats.push(...points.map((p) => p.lat))
    for (const landing of flight.landings) {
      // Keep the dot on the same side of the date line as its flight.
      let lon = landing.lon
      while (lon - unwrapped[0] > 180) lon -= 360
      while (lon - unwrapped[0] < -180) lon += 360
      landings.push({ type: 'Feature', properties: { id: flight.id }, geometry: { type: 'Point', coordinates: [lon, landing.lat] } })
    }
  }

  const airMinutes = flights.reduce((sum, { flight }) => sum + (flightAirMinutes(flight) ?? 0), 0)

  return {
    lines: { type: 'FeatureCollection', features: lines },
    landings: { type: 'FeatureCollection', features: landings },
    bounds: lons.length
      ? [
          [Math.min(...lons), Math.min(...lats)],
          [Math.max(...lons), Math.max(...lats)]
        ]
      : null,
    totals: {
      flights: flights.length,
      airMinutes,
      distanceNm: flights.reduce((sum, { flight }) => sum + flight.distanceNm, 0),
      landings: flights.reduce((sum, { flight }) => sum + flight.landings.length, 0)
    }
  }
}

/** "KRIU → KSAC", or as much of it as is known. */
export function routeLabel({ fromIdent, toIdent, flight }: AircraftFlight): string {
  const from = fromIdent ?? (flight.startedAirborne ? 'In the air' : 'Off airport')
  const to = toIdent ?? (flight.landings.length > 0 ? 'Off airport' : flight.status === 'complete' ? '—' : 'Not landed')
  return `${from} → ${to}`
}
