import { type GeoJSONSource, Map as MapLibreMap, NavigationControl, Popup } from 'maplibre-gl'
import { useEffect, useRef, useState } from 'react'
import type { FlightPhoto, LogbookFlight } from '../../shared/logbook'
import {
  buildTrack,
  type FlightTrack,
  formatMetric,
  gradientExpression,
  METRICS,
  nearestPoint,
  type PlottedPoint,
  RAMP,
  type TrackMetric
} from './flightTrack'
import { OUTLINE, STYLE_URL } from './mapSetup'

const HOVER_PX = 10

function tooltip(point: PlottedPoint, startedAt: number): HTMLElement {
  const root = document.createElement('div')
  const minutes = Math.max(0, Math.round(point.simSeconds !== null ? point.simSeconds / 60 : (point.t - startedAt) / 60000))
  const title = document.createElement('strong')
  title.textContent = `${new Date(point.t).toLocaleTimeString()} · ${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')} in`
  root.append(title)
  for (const metric of METRICS) {
    const line = document.createElement('p')
    line.textContent = `${metric.label}: ${formatMetric(metric.id, point[metric.id])}`
    root.append(line)
  }
  return root
}

/** A recorded flight on the map, coloured by the measure the player picks. */
export function FlightMap({ flight, photos = [], onOpenPhoto }: { flight: LogbookFlight; photos?: FlightPhoto[]; onOpenPhoto?: (id: string) => void }) {
  const latestOpen = useRef(onOpenPhoto)
  latestOpen.current = onOpenPhoto
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [track, setTrack] = useState<FlightTrack | null | 'loading'>('loading')
  const [metric, setMetric] = useState<TrackMetric>('altFt')
  const latestStart = useRef(flight.takeoffAt ?? flight.startedAt)
  latestStart.current = flight.takeoffAt ?? flight.startedAt
  const latestTrack = useRef<FlightTrack | null>(null)
  latestTrack.current = track === 'loading' ? null : track

  useEffect(() => {
    let current = true
    setTrack('loading')
    void Promise.resolve()
      .then(() => window.journeys.flightTrack(flight.id))
      .then((points) => current && setTrack(buildTrack(points, flight.landings)))
      .catch(() => current && setTrack(null))
    return () => {
      current = false
    }
    // The logbook refreshes every few seconds; only a different flight or a new landing needs a new line.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flight.id, flight.landings.length])

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
      // lineMetrics lets the colour change along a single line.
      map.addSource('flight-track', { type: 'geojson', data: empty, lineMetrics: true })
      map.addSource('flight-marks', { type: 'geojson', data: empty })
      const round = { 'line-cap': 'round', 'line-join': 'round' } as const
      // A dark casing keeps the line readable over water and roads.
      map.addLayer({ id: 'flight-track-casing', type: 'line', source: 'flight-track', layout: round, paint: { 'line-width': 5, 'line-color': OUTLINE } })
      map.addLayer({ id: 'flight-track', type: 'line', source: 'flight-track', layout: round, paint: { 'line-width': 3, 'line-color': RAMP[0] } })
      map.addSource('flight-photos', { type: 'geojson', data: empty })
      map.addLayer({
        id: 'flight-marks',
        type: 'circle',
        source: 'flight-marks',
        paint: {
          'circle-radius': ['match', ['get', 'kind'], 'landing', 5, 6],
          'circle-color': ['match', ['get', 'kind'], 'start', '#e6ebf3', 'end', '#e6ebf3', '#f2b544'],
          'circle-stroke-width': 2,
          'circle-stroke-color': OUTLINE
        }
      })
      // Photos sit on top: a ring the player can click to see where a picture was taken.
      map.addLayer({
        id: 'flight-photos',
        type: 'circle',
        source: 'flight-photos',
        paint: { 'circle-radius': 7, 'circle-color': '#f2b544', 'circle-stroke-width': 2.5, 'circle-stroke-color': '#e6ebf3' }
      })
      map.on('click', 'flight-photos', (event) => {
        const id = event.features?.[0]?.properties?.id as string | undefined
        if (id) latestOpen.current?.(id)
      })
      map.on('mouseenter', 'flight-photos', () => (map.getCanvas().style.cursor = 'pointer'))
      setReady(true)
    })

    const hover =new Popup({ closeButton: false, closeOnClick: false, maxWidth: '240px', offset: 12 })
    map.on('mousemove', ({ point: mouse, lngLat }) => {
      if (map.getLayer('flight-photos') && map.queryRenderedFeatures(mouse, { layers: ['flight-photos'] }).length > 0) {
        hover.remove()
        map.getCanvas().style.cursor = 'pointer'
        return
      }
      const current = latestTrack.current
      const nearest = current && nearestPoint(current, lngLat.lng, lngLat.lat)
      const onScreen = nearest && map.project([nearest.lon, nearest.lat])
      if (!nearest || !onScreen || Math.hypot(onScreen.x - mouse.x, onScreen.y - mouse.y) > HOVER_PX) {
        hover.remove()
        map.getCanvas().style.cursor = ''
        return
      }
      map.getCanvas().style.cursor = 'crosshair'
      hover.setLngLat([nearest.lon, nearest.lat]).setDOMContent(tooltip(nearest, latestStart.current)).addTo(map)
    })
    map.on('mouseout', () => hover.remove())

    const observer = new ResizeObserver(() => map.resize())
    observer.observe(container.current)
    return () => {
      observer.disconnect()
      hover.remove()
      setReady(false)
      mapRef.current = null
      map.remove()
    }
  }, [])

  // New flight: new line, framed.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || track === 'loading') return
    const none = { type: 'FeatureCollection' as const, features: [] }
    ;(map.getSource('flight-track') as GeoJSONSource).setData(track?.line ?? none)
    ;(map.getSource('flight-marks') as GeoJSONSource).setData(track?.marks ?? none)
    if (track) map.fitBounds(track.bounds, { padding: 48, maxZoom: 12, animate: false })
  }, [track, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    ;(map.getSource('flight-photos') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: photos
        .filter((photo) => photo.lat !== null && photo.lon !== null)
        .map((photo) => ({ type: 'Feature', properties: { id: photo.id }, geometry: { type: 'Point', coordinates: [photo.lon!, photo.lat!] } }))
    })
  }, [photos, ready])

  // New measure: same line, new colours.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !track || track === 'loading') return
    map.setPaintProperty('flight-track', 'line-gradient', gradientExpression(track, metric) as never)
  }, [metric, track, ready])

  const domain = track && track !== 'loading' ? track.domain[metric] : null
  return (
    <div className="flight-map-panel">
      <div className="flight-map-controls">
        <div className="segmented" role="radiogroup" aria-label="Colour the line by">
          {METRICS.map((m) => (
            <button key={m.id} role="radio" aria-checked={metric === m.id} className={metric === m.id ? 'active' : ''} onClick={() => setMetric(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        {domain && (
          <div className="legend" aria-label={`${METRICS.find((m) => m.id === metric)!.label} scale`}>
            <span>{formatMetric(metric, domain[0])}</span>
            <span className="legend-ramp" style={{ background: `linear-gradient(to right, ${RAMP.join(', ')})` }} />
            <span>{formatMetric(metric, domain[1])}</span>
          </div>
        )}
      </div>
      {failed ? (
        <p className="muted">The map couldn't load. Check your internet connection.</p>
      ) : (
        <div className="journey-map flight-map">
          <div ref={container} className="journey-map-canvas" role="region" aria-label="Map of the selected flight" />
          {track === null && <p className="map-hint">No recorded path for this flight.</p>}
        </div>
      )}
    </div>
  )
}
