import { type GeoJSONSource, Map as MapLibreMap, NavigationControl, Popup } from 'maplibre-gl'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { type AircraftFlight, airMinutes } from '../../shared/logbook'
import { aircraftTracks, routeLabel } from './aircraftTracks'
import { OUTLINE, STYLE_URL } from './mapSetup'

const LINE = '#5598e7'
const HIGHLIGHT = '#f2b544'
const HOVER_PX = 6

const hoursMinutes = (minutes: number) => `${Math.floor(minutes / 60)}h ${String(Math.round(minutes % 60)).padStart(2, '0')}m`

/** Every flight one aircraft has made, loaded for its Hangar card. */
export function AircraftMap({ airframeKey }: { airframeKey: string }) {
  const [flights, setFlights] = useState<AircraftFlight[] | null>(null)
  useEffect(() => {
    let current = true
    void Promise.resolve()
      .then(() => window.journeys.airframeFlights(airframeKey))
      .then((loaded) => current && setFlights(loaded))
      .catch(() => current && setFlights([]))
    return () => {
      current = false
    }
  }, [airframeKey])
  return (
    <FlightsMap
      flights={flights}
      label="Map of every flight in this aircraft"
      emptyText="No finished flights in this aircraft yet. Unfinished ones can be shown on maps from Settings."
    />
  )
}

/** Many flights on one map, with a list to pick one out. Used per aircraft and for the atlas. */
export function FlightsMap({
  flights,
  label,
  emptyText,
  showAircraft = false,
  children
}: {
  flights: AircraftFlight[] | null
  label: string
  emptyText: string
  /** Name the aircraft in the list, when the flights aren't all in one. */
  showAircraft?: boolean
  children?: ReactNode
}) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const tracks = useMemo(() => (flights ? aircraftTracks(flights) : null), [flights])
  const byId = useRef(new Map<string, AircraftFlight>())
  byId.current = new Map(flights?.map((f) => [f.flight.id, f]))

  useEffect(() => {
    if (!container.current) return
    const map = new MapLibreMap({ container: container.current, style: STYLE_URL, center: [-98, 39], zoom: 2, dragRotate: false, attributionControl: { compact: true } })
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    mapRef.current = map
    let styleArrived = false
    map.once('styledata', () => (styleArrived = true))
    map.on('error', (event) => {
      console.error('Map error:', event.error)
      if (!styleArrived) setFailed(true)
    })
    map.on('load', () => {
      const empty = { type: 'FeatureCollection' as const, features: [] }
      map.addSource('aircraft-lines', { type: 'geojson', data: empty })
      map.addSource('aircraft-landings', { type: 'geojson', data: empty })
      const round = { 'line-cap': 'round', 'line-join': 'round' } as const
      map.addLayer({ id: 'aircraft-lines-casing', type: 'line', source: 'aircraft-lines', layout: round, paint: { 'line-width': 4.5, 'line-color': OUTLINE } })
      map.addLayer({ id: 'aircraft-lines', type: 'line', source: 'aircraft-lines', layout: round, paint: { 'line-width': 2.5, 'line-color': LINE, 'line-opacity': 0.85 } })
      map.addLayer({
        id: 'aircraft-lines-highlight',
        type: 'line',
        source: 'aircraft-lines',
        layout: round,
        filter: ['==', ['get', 'id'], ''],
        paint: { 'line-width': 4, 'line-color': HIGHLIGHT }
      })
      map.addLayer({
        id: 'aircraft-landings',
        type: 'circle',
        source: 'aircraft-landings',
        paint: { 'circle-radius': 3.5, 'circle-color': '#e6ebf3', 'circle-stroke-width': 1.5, 'circle-stroke-color': OUTLINE }
      })
      setReady(true)
    })

    const tip = new Popup({ closeButton: false, closeOnClick: false, maxWidth: '260px', offset: 10 })
    const flightAt = (x: number, y: number) => {
      // The mouse can move before the lines are added.
      if (!map.getLayer('aircraft-lines')) return null
      const [hit] = map.queryRenderedFeatures(
        [
          [x - HOVER_PX, y - HOVER_PX],
          [x + HOVER_PX, y + HOVER_PX]
        ],
        { layers: ['aircraft-lines'] }
      )
      return hit ? byId.current.get(hit.properties.id as string) ?? null : null
    }
    map.on('mousemove', ({ point, lngLat }) => {
      const found = flightAt(point.x, point.y)
      setHovered(found?.flight.id ?? null)
      map.getCanvas().style.cursor = found ? 'pointer' : ''
      if (!found) return void tip.remove()
      const root = document.createElement('div')
      const title = document.createElement('strong')
      title.textContent = routeLabel(found)
      const when = document.createElement('p')
      when.textContent = new Date(found.flight.startedAt).toLocaleString()
      root.append(title, when)
      tip.setLngLat(lngLat).setDOMContent(root).addTo(map)
    })
    map.on('mouseout', () => {
      setHovered(null)
      tip.remove()
    })
    map.on('click', ({ point }) => {
      const found = flightAt(point.x, point.y)
      setSelected((current) => (found ? (current === found.flight.id ? null : found.flight.id) : current))
    })

    const observer = new ResizeObserver(() => map.resize())
    observer.observe(container.current)
    return () => {
      observer.disconnect()
      tip.remove()
      setReady(false)
      mapRef.current = null
      map.remove()
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !tracks) return
    ;(map.getSource('aircraft-lines') as GeoJSONSource).setData(tracks.lines)
    ;(map.getSource('aircraft-landings') as GeoJSONSource).setData(tracks.landings)
    if (tracks.bounds) map.fitBounds(tracks.bounds, { padding: 40, maxZoom: 10, animate: false })
  }, [tracks, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    map.setFilter('aircraft-lines-highlight', ['==', ['get', 'id'], hovered ?? selected ?? ''])
  }, [hovered, selected, ready])

  // Picking a flight in the list zooms to it.
  useEffect(() => {
    const map = mapRef.current
    const line = tracks?.lines.features.find((f) => f.properties.id === selected)
    if (!map || !ready || !line) return
    const lons = line.geometry.coordinates.map(([lon]) => lon)
    const lats = line.geometry.coordinates.map(([, lat]) => lat)
    map.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)]
      ],
      { padding: 60, maxZoom: 11, duration: 600 }
    )
  }, [selected, tracks, ready])

  if (flights && flights.length === 0) return <p className="muted">{emptyText}</p>
  return (
    <div className="aircraft-flights">
      {children}
      {tracks && (
        <p className="muted">
          {tracks.totals.flights} {tracks.totals.flights === 1 ? 'flight' : 'flights'} · {hoursMinutes(tracks.totals.airMinutes)} in the air ·{' '}
          {Math.round(tracks.totals.distanceNm).toLocaleString()} nm · {tracks.totals.landings}{' '}
          {tracks.totals.landings === 1 ? 'landing' : 'landings'}
        </p>
      )}
      {failed ? (
        <p className="muted">The map couldn't load. Check your internet connection.</p>
      ) : (
        <div className="journey-map aircraft-map">
          <div ref={container} className="journey-map-canvas" role="region" aria-label={label} />
        </div>
      )}
      {flights && (
        <ul className="aircraft-flight-list" onMouseLeave={() => setHovered(null)}>
          {flights.map((entry) => {
            const minutes = airMinutes(entry.flight)
            const id = entry.flight.id
            return (
              <li key={id}>
                <button
                  className={id === selected ? 'selected' : ''}
                  aria-pressed={id === selected}
                  onMouseEnter={() => setHovered(id)}
                  onFocus={() => setHovered(id)}
                  onBlur={() => setHovered(null)}
                  onClick={() => setSelected((current) => (current === id ? null : id))}
                >
                  <strong>{routeLabel(entry)}</strong>
                  <span className="muted">
                    {showAircraft && entry.flight.aircraft ? `${entry.flight.aircraft.title} · ` : ''}
                    {new Date(entry.flight.startedAt).toLocaleDateString()} · {minutes === null ? '—' : hoursMinutes(minutes)} ·{' '}
                    {Math.round(entry.flight.distanceNm)} nm
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
