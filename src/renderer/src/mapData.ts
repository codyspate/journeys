import type { Feature, FeatureCollection, LineString, Point } from 'geojson'
import type { Airport, AirportSize, Journey, Stop } from '../../shared/journey'

export type LineStatus = 'flown' | 'firm' | 'tentative'
export type StopKind = 'endpoint' | 'current' | 'stop'
/** What dragging a stop on the map would change. null: it can't be dragged. */
export type StopRole = 'origin' | 'stop' | 'destination' | null

export interface StopProperties {
  ident: string
  name: string
  kind: StopKind
  role: StopRole
  /** Position along the route, so a drag can draw the legs either side. */
  index: number
}

export interface JourneyMapData {
  lines: FeatureCollection<LineString, { status: LineStatus }>
  stops: FeatureCollection<Point, StopProperties>
  bounds: [[number, number], [number, number]]
}

export type AirportProperties = Pick<Airport, 'ident' | 'name' | 'city' | 'country' | 'elevationFt' | 'runwayFt' | 'hardSurface'> & {
  size: AirportSize
  /** Other codes, comma separated, since map features can't hold lists. */
  otherCodes: string
}

export function airportFeatures(airports: Airport[]): FeatureCollection<Point, AirportProperties> {
  return {
    type: 'FeatureCollection',
    features: airports.map(({ lat, lon, ident, name, city, country, elevationFt, runwayFt, hardSurface, size, codes }) => ({
      type: 'Feature',
      properties: { ident, name, city, country, elevationFt, runwayFt, hardSurface, size, otherCodes: (codes ?? []).join(', ') },
      geometry: { type: 'Point', coordinates: [lon, lat] }
    }))
  }
}

/** Every airport this Journey already passes through, flown or planned. */
export function routeIdents(journey: Journey): Set<string> {
  return new Set([journey.origin.ident, ...journey.legs.map((leg) => leg.to.ident)])
}

/** Keeps longitudes continuous so a route across the date line doesn't wrap the long way round. */
export function unwrapLongitudes(longitudes: number[]): number[] {
  const result: number[] = []
  for (const longitude of longitudes) {
    const previous = result.at(-1)
    if (previous === undefined) {
      result.push(longitude)
      continue
    }
    let adjusted = longitude
    while (adjusted - previous > 180) adjusted -= 360
    while (adjusted - previous < -180) adjusted += 360
    result.push(adjusted)
  }
  return result
}

export function journeyMapData(journey: Journey): JourneyMapData {
  const points: Stop[] = [journey.origin, ...journey.legs.map((leg) => leg.to)]
  const longitudes = unwrapLongitudes(points.map((point) => point.lon))
  const flownCount = journey.legs.filter((leg) => leg.status === 'flown').length

  const lines = journey.legs.map(
    (leg, index): Feature<LineString, { status: LineStatus }> => ({
      type: 'Feature',
      properties: { status: leg.status === 'flown' ? 'flown' : leg.confidence },
      geometry: {
        type: 'LineString',
        coordinates: [
          [longitudes[index], points[index].lat],
          [longitudes[index + 1], points[index + 1].lat]
        ]
      }
    })
  )

  const active = journey.status === 'active'
  const last = points.length - 1
  const roleOf = (index: number): StopRole => {
    if (!active) return null
    if (index === 0) return flownCount === 0 ? 'origin' : null
    if (index <= flownCount) return null
    return index === last ? 'destination' : 'stop'
  }
  const stops = points.map((point, index): Feature<Point, StopProperties> => {
    let kind: StopKind = index === 0 || index === last ? 'endpoint' : 'stop'
    if (index === flownCount && active) kind = 'current'
    return {
      type: 'Feature',
      properties: { ident: point.ident, name: point.name, kind, role: roleOf(index), index },
      geometry: { type: 'Point', coordinates: [longitudes[index], point.lat] }
    }
  })

  const lats = points.map((point) => point.lat)
  return {
    lines: { type: 'FeatureCollection', features: lines },
    stops: { type: 'FeatureCollection', features: stops },
    bounds: [
      [Math.min(...longitudes), Math.min(...lats)],
      [Math.max(...longitudes), Math.max(...lats)]
    ]
  }
}
