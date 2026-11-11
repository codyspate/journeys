import type { Feature, FeatureCollection, LineString, Point } from 'geojson'
import { type GeoJSONSource, Map as MapLibreMap, NavigationControl } from 'maplibre-gl'
import { useEffect, useRef, useState } from 'react'
import type { LiveSim } from '../../shared/airframe'
import type { Stop } from '../../shared/journey'
import { isRealPosition } from '../../shared/logbook'
import { OUTLINE, STYLE_URL } from './mapSetup'

const POLL_MS = 1000
/** New trail points closer than this to the last one add nothing visible. */
const TRAIL_STEP_DEG = 0.0005
const FOLLOW_ZOOM = 8.5
const TRAIL = '#5598e7'
const LEG = '#f2b544'

type Coordinates = [number, number]

/** A top-down aircraft arrow, drawn once and handed to the map as an icon. */
function aircraftIcon(size = 48): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')!
  const s = size / 48
  g.beginPath()
  g.moveTo(24 * s, 4 * s)
  g.lineTo(40 * s, 42 * s)
  g.lineTo(24 * s, 34 * s)
  g.lineTo(8 * s, 42 * s)
  g.closePath()
  g.fillStyle = LEG
  g.fill()
  g.lineWidth = 3 * s
  g.strokeStyle = OUTLINE
  g.stroke()
  return g.getImageData(0, 0, size, size)
}

const line = (coordinates: Coordinates[]): FeatureCollection<LineString> => ({
  type: 'FeatureCollection',
  features: coordinates.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }] : []
})

function distanceNm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * The aircraft where it is right now, the trail it has flown this flight and the leg it's flying,
 * updated every second. The view follows the aircraft until the player pans away.
 */
export function LiveFlightMap({ leg }: { leg: { from: Stop; to: Stop } | null }) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const trail = useRef<Coordinates[]>([])
  const trailFlight = useRef<string | null>(null)
  const following = useRef(true)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [live, setLive] = useState<LiveSim | null>(null)
  const [follow, setFollow] = useState(true)

  const position = live && live.lat !== null && live.lon !== null && isRealPosition(live.lat, live.lon) ? { lat: live.lat, lon: live.lon } : null

  useEffect(() => {
    let stopped = false
    const poll = () =>
      void window.journeys
        .liveSim?.()
        .then((next) => !stopped && setLive(next))
        .catch(() => {})
    poll()
    const timer = setInterval(poll, POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!container.current) return
    const map = new MapLibreMap({ container: container.current, style: STYLE_URL, center: [-98, 39], zoom: 3, dragRotate: false, attributionControl: { compact: true } })
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    mapRef.current = map
    let styleArrived = false
    map.once('styledata', () => (styleArrived = true))
    map.on('error', (event) => {
      console.error('Map error:', event.error)
      if (!styleArrived) setFailed(true)
    })
    map.on('load', () => {
      map.addImage('aircraft', aircraftIcon(), { pixelRatio: 2 })
      const empty = { type: 'FeatureCollection' as const, features: [] }
      for (const id of ['live-leg', 'live-trail', 'live-aircraft']) map.addSource(id, { type: 'geojson', data: empty })
      map.addLayer({ id: 'live-leg', type: 'line', source: 'live-leg', paint: { 'line-width': 2, 'line-color': LEG, 'line-dasharray': [2, 2], 'line-opacity': 0.8 } })
      map.addLayer({ id: 'live-trail-casing', type: 'line', source: 'live-trail', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-width': 5, 'line-color': OUTLINE } })
      map.addLayer({ id: 'live-trail', type: 'line', source: 'live-trail', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-width': 3, 'line-color': TRAIL } })
      map.addLayer({
        id: 'live-aircraft',
        type: 'symbol',
        source: 'live-aircraft',
        layout: {
          'icon-image': 'aircraft',
          'icon-rotate': ['get', 'heading'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true
        }
      })
      setReady(true)
    })
    // Panning by hand stops the view following the aircraft.
    map.on('dragstart', () => {
      following.current = false
      setFollow(false)
    })
    const observer = new ResizeObserver(() => map.resize())
    observer.observe(container.current)
    return () => {
      observer.disconnect()
      setReady(false)
      mapRef.current = null
      map.remove()
    }
  }, [])

  // A new flight starts a new trail, beginning with whatever was flown before this screen opened.
  const flightId = live?.flightId ?? null
  useEffect(() => {
    if (flightId === trailFlight.current) return
    trailFlight.current = flightId
    trail.current = []
    if (!flightId) return
    void window.journeys
      .flightTrack(flightId)
      .then((points) => {
        if (trailFlight.current !== flightId) return
        const earlier = points.filter((p) => isRealPosition(p.lat, p.lon)).map((p): Coordinates => [p.lon, p.lat])
        trail.current = [...earlier, ...trail.current]
      })
      .catch(() => {})
  }, [flightId])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    ;(map.getSource('live-leg') as GeoJSONSource).setData(
      line(leg ? [[leg.from.lon, leg.from.lat], [leg.to.lon, leg.to.lat]] : [])
    )
  }, [leg, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !position) return
    const here: Coordinates = [position.lon, position.lat]
    const last = trail.current.at(-1)
    if (!live?.paused && (!last || Math.hypot(last[0] - here[0], last[1] - here[1]) > TRAIL_STEP_DEG)) trail.current.push(here)
    ;(map.getSource('live-trail') as GeoJSONSource).setData(line(trail.current))
    const aircraft: Feature<Point, { heading: number }> = {
      type: 'Feature',
      properties: { heading: live?.headingTrue ?? 0 },
      geometry: { type: 'Point', coordinates: here }
    }
    ;(map.getSource('live-aircraft') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [aircraft] })
    if (following.current) {
      const first = map.getZoom() < 5
      if (first) map.jumpTo({ center: here, zoom: FOLLOW_ZOOM })
      else map.easeTo({ center: here, duration: POLL_MS * 0.9, easing: (t) => t })
    }
  }, [live, ready]) // eslint-disable-line react-hooks/exhaustive-deps

  if (failed) return null
  const toGo = position && leg ? distanceNm(position, leg.to) : null
  return (
    <div className="live-map-panel">
      <div className="journey-map live-map">
        <div ref={container} className="journey-map-canvas" role="region" aria-label="Live map of your flight" />
        {!position && (
          <p className="live-empty">{live?.connected ? 'Waiting for a flight to load.' : 'Your aircraft will show here when the sim is running.'}</p>
        )}
        {position && (
          <div className="live-readout" aria-live="off">
            {live?.altFt != null && <span>{Math.round(live.altFt).toLocaleString()} ft</span>}
            {live?.gsKts != null && <span>{Math.round(live.gsKts)} kt</span>}
            {live?.headingTrue != null && <span>{String(Math.round(live.headingTrue) % 360).padStart(3, '0')}°</span>}
            {toGo !== null && leg && (
              <span>
                {Math.round(toGo)} nm to {leg.to.ident}
              </span>
            )}
            {live?.paused && <span>Paused</span>}
          </div>
        )}
        {position && !follow && (
          <button
            className="secondary live-follow"
            onClick={() => {
              following.current = true
              setFollow(true)
              mapRef.current?.easeTo({ center: [position.lon, position.lat], zoom: Math.max(mapRef.current.getZoom(), 6) })
            }}
          >
            Follow aircraft
          </button>
        )}
      </div>
    </div>
  )
}
