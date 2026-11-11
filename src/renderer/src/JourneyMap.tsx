import type { FeatureCollection, Point } from 'geojson'
import { type GeoJSONSource, Map as MapLibreMap, type MapGeoJSONFeature, type MapMouseEvent, NavigationControl, Popup } from 'maplibre-gl'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { AirportSize, Journey, RouteEdit } from '../../shared/journey'
import { airportFeatures, type AirportProperties, journeyMapData, routeIdents, type StopProperties } from './mapData'
import { LABEL_FONT, STYLE_URL } from './mapSetup'

const COLOR = { flown: '#5fd08a', planned: '#f2b544', tentative: '#8f9db3', stop: '#e6ebf3', outline: '#0e1420' }
const CLICK_MARGIN_PX = 6

// Smaller fields appear as you zoom in. Listed bottom to top, so bigger airports win a crowded click.
const AIRPORT_TIERS: { size: AirportSize; dotZoom: number; labelZoom: number; radius: number; color: string }[] = [
  { size: 'small', dotZoom: 7, labelZoom: 9.5, radius: 3, color: '#64809f' },
  { size: 'medium', dotZoom: 5, labelZoom: 7.5, radius: 3.5, color: '#7fa8d4' },
  { size: 'large', dotZoom: 2.5, labelZoom: 5, radius: 4.5, color: '#9cc4ee' }
]
const AIRPORT_DOT_LAYERS = AIRPORT_TIERS.map((tier) => `airports-${tier.size}`)

// The list is large and never changes, so it is only fetched once.
let airportData: Promise<FeatureCollection> | null = null
const loadAirports = () => (airportData ??= window.journeys.listAirports().then(airportFeatures))

function addAirportLayers(map: MapLibreMap): void {
  map.addSource('airports', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  for (const tier of AIRPORT_TIERS) {
    const filter = ['==', ['get', 'size'], tier.size] as ['==', ['get', string], string]
    map.addLayer({
      id: `airports-${tier.size}`,
      type: 'circle',
      source: 'airports',
      minzoom: tier.dotZoom,
      filter,
      paint: { 'circle-radius': tier.radius, 'circle-color': tier.color, 'circle-stroke-width': 1, 'circle-stroke-color': COLOR.outline }
    })
    map.addLayer({
      id: `airports-${tier.size}-labels`,
      type: 'symbol',
      source: 'airports',
      minzoom: tier.labelZoom,
      filter,
      layout: { 'text-field': ['get', 'ident'], 'text-font': LABEL_FONT, 'text-size': 11, 'text-offset': [0, 0.8], 'text-anchor': 'top' },
      paint: { 'text-color': tier.color, 'text-halo-color': COLOR.outline, 'text-halo-width': 1.2 }
    })
  }
}

function airportPopup(airport: AirportProperties, onRoute: boolean, onAdd: (() => void) | null): HTMLElement {
  const root = document.createElement('div')
  const line = (text: string, className?: string) => {
    const element = document.createElement('p')
    element.textContent = text
    if (className) element.className = className
    root.append(element)
  }

  const title = document.createElement('strong')
  title.textContent = `${airport.ident} · ${airport.name}`
  root.append(title)
  line([airport.city, airport.country].filter(Boolean).join(', '), 'muted')
  if (airport.otherCodes) line(`Also ${airport.otherCodes}`, 'muted')
  const runway =
    airport.runwayFt > 0 ? `${airport.runwayFt.toLocaleString()} ft ${airport.hardSurface ? 'paved' : 'unpaved'} runway` : 'Runway length unknown'
  line(`${runway} · ${airport.elevationFt.toLocaleString()} ft elevation`, 'muted')

  if (onRoute) line('On this route')
  if (onAdd) {
    const button = document.createElement('button')
    button.textContent = 'Add as a stop'
    button.addEventListener('click', onAdd)
    root.append(button)
  }
  return root
}

function addRouteLayers(map: MapLibreMap): void {
  const empty: FeatureCollection = { type: 'FeatureCollection', features: [] }
  map.addSource('journey-lines', { type: 'geojson', data: empty })
  map.addSource('journey-stops', { type: 'geojson', data: empty })

  map.addLayer({
    id: 'journey-lines-solid',
    type: 'line',
    source: 'journey-lines',
    filter: ['!=', ['get', 'status'], 'tentative'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-width': 3, 'line-color': ['match', ['get', 'status'], 'flown', COLOR.flown, COLOR.planned] }
  })
  map.addLayer({
    id: 'journey-lines-tentative',
    type: 'line',
    source: 'journey-lines',
    filter: ['==', ['get', 'status'], 'tentative'],
    paint: { 'line-width': 2.5, 'line-color': COLOR.tentative, 'line-dasharray': [2, 2] }
  })
  map.addLayer({
    id: 'journey-stops-dots',
    type: 'circle',
    source: 'journey-stops',
    paint: {
      'circle-radius': ['match', ['get', 'kind'], 'current', 8, 'endpoint', 6, 5],
      'circle-color': ['match', ['get', 'kind'], 'current', COLOR.planned, COLOR.stop],
      'circle-stroke-width': 2,
      'circle-stroke-color': COLOR.outline
    }
  })
  map.addLayer({
    id: 'journey-stops-labels',
    type: 'symbol',
    source: 'journey-stops',
    layout: {
      'text-field': ['get', 'ident'],
      'text-font': LABEL_FONT,
      'text-size': 13,
      'text-offset': [0, 1.2],
      'text-anchor': 'top',
      'text-allow-overlap': true
    },
    paint: { 'text-color': COLOR.stop, 'text-halo-color': COLOR.outline, 'text-halo-width': 1.5 }
  })
}

const DRAG_START_PX = 4
const SNAP_PX = 12
const emptyCollection = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] })

/** The stop being dragged, with dashed legs to its neighbours. */
function addDragLayers(map: MapLibreMap): void {
  map.addSource('journey-drag', { type: 'geojson', data: emptyCollection() })
  map.addLayer({
    id: 'journey-drag-lines',
    type: 'line',
    source: 'journey-drag',
    filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 'line-width': 2.5, 'line-color': COLOR.planned, 'line-dasharray': [1.5, 1.5] }
  })
  map.addLayer({
    id: 'journey-drag-point',
    type: 'circle',
    source: 'journey-drag',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': ['case', ['get', 'snapped'], 9, 6],
      'circle-color': ['case', ['get', 'snapped'], COLOR.planned, 'rgba(242,181,68,0.35)'],
      'circle-stroke-width': 2,
      'circle-stroke-color': COLOR.planned
    }
  })
}

function choicePopup(from: string, to: AirportProperties, ownLater: number, choose: (rest: 'keep' | 'replan') => void): HTMLElement {
  const root = document.createElement('div')
  const title = document.createElement('strong')
  title.textContent = `Move ${from} to ${to.ident}`
  const detail = document.createElement('p')
  detail.className = 'muted'
  detail.textContent = `${to.name}. Stops before it stay as they are.`
  const keep = document.createElement('button')
  keep.textContent = 'Keep the rest of the route'
  keep.addEventListener('click', () => choose('keep'))
  const replan = document.createElement('button')
  replan.className = 'secondary'
  replan.textContent = `Re-plan the rest from ${to.ident}`
  replan.addEventListener('click', () => choose('replan'))
  const actions = document.createElement('div')
  actions.className = 'popup-actions'
  actions.append(keep, replan)
  root.append(title, detail, actions)
  if (ownLater > 0) {
    const note = document.createElement('p')
    note.className = 'muted'
    note.textContent = `Re-planning also drops ${ownLater === 1 ? 'the later stop' : `the ${ownLater} later stops`} you chose yourself.`
    root.append(note)
  }
  return root
}

interface JourneyMapProps {
  journey: Journey
  fallback: ReactNode
  onEdit: (edit: RouteEdit) => void
}

export function JourneyMap({ journey, fallback, onEdit }: JourneyMapProps) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const fit = useRef<() => void>(() => {})
  const popup = useRef<Popup | null>(null)
  const clearDrag = useRef<() => void>(() => {})
  // Changing the route from the map leaves the view where the player zoomed to.
  const keepView = useRef(false)
  const latest = useRef({ journey, onEdit, data: journeyMapData(journey) })
  latest.current = { journey, onEdit, data: latest.current.data }
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!container.current) return
    const map = new MapLibreMap({
      container: container.current,
      style: STYLE_URL,
      center: [-98, 39],
      zoom: 2,
      dragRotate: false,
      attributionControl: { compact: true }
    })
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    mapRef.current = map

    // A single missing tile is harmless. Only losing the style itself leaves no map to show.
    let styleArrived = false
    map.once('styledata', () => {
      styleArrived = true
    })
    map.on('error', (event) => {
      console.error('Map error:', event.error)
      if (!styleArrived) setFailed(true)
    })
    map.on('load', () => {
      addAirportLayers(map)
      addRouteLayers(map)
      addDragLayers(map)
      setReady(true)
      void loadAirports()
        .then((data) => {
          if (mapRef.current === map) (map.getSource('airports') as GeoJSONSource).setData(data)
        })
        .catch((error) => console.error('Could not load airports:', error))
    })

    const openAirport = (feature: MapGeoJSONFeature) => {
      const airport = feature.properties as AirportProperties
      const { journey: current, onEdit: edit } = latest.current
      const add = (ident: string) => edit({ kind: 'add', ident })
      const onRoute = routeIdents(current).has(airport.ident)
      const canAdd = current.status === 'active' && !onRoute
      const [lon, lat] = (feature.geometry as Point).coordinates
      const opened = new Popup({ maxWidth: '280px' }).setLngLat([lon, lat])
      opened.setDOMContent(
        airportPopup(
          airport,
          onRoute,
          canAdd
            ? () => {
                keepView.current = true
                opened.remove()
                add(airport.ident)
              }
            : null
        )
      )
      opened.addTo(map)
      popup.current = opened
    }

    // Dragging a stop: press on it, move onto another airport, let go.
    type Coordinates = [number, number]
    let drag: {
      stop: StopProperties
      start: { x: number; y: number }
      previous: Coordinates | null
      next: Coordinates | null
      moving: boolean
      target: { airport: AirportProperties; at: Coordinates } | null
    } | null = null
    let suppressClick = false

    const setDragShape = (at: Coordinates | null, snapped: boolean) => {
      const source = map.getSource('journey-drag') as GeoJSONSource | undefined
      if (!source) return
      if (!drag || !at) return source.setData(emptyCollection())
      const line = (a: Coordinates, b: Coordinates) => ({
        type: 'Feature' as const,
        properties: {},
        geometry: { type: 'LineString' as const, coordinates: [a, b] }
      })
      source.setData({
        type: 'FeatureCollection',
        features: [
          ...(drag.previous ? [line(drag.previous, at)] : []),
          ...(drag.next ? [line(at, drag.next)] : []),
          { type: 'Feature', properties: { snapped }, geometry: { type: 'Point', coordinates: at } }
        ]
      })
    }
    clearDrag.current = () => {
      drag = null
      setDragShape(null, false)
    }

    // Keeps the dragged point on the same side of the date line as the route.
    const nearRoute = (lon: number): number => {
      const anchor = drag?.previous?.[0] ?? drag?.next?.[0] ?? lon
      while (lon - anchor > 180) lon -= 360
      while (lon - anchor < -180) lon += 360
      return lon
    }

    const onDragMove = (event: MapMouseEvent) => {
      if (!drag) return
      if (!drag.moving && Math.hypot(event.point.x - drag.start.x, event.point.y - drag.start.y) < DRAG_START_PX) return
      drag.moving = true
      const { x, y } = event.point
      const onRoute = routeIdents(latest.current.journey)
      const [hit] = map
        .queryRenderedFeatures(
          [
            [x - SNAP_PX, y - SNAP_PX],
            [x + SNAP_PX, y + SNAP_PX]
          ],
          { layers: AIRPORT_DOT_LAYERS }
        )
        .filter((feature) => !onRoute.has((feature.properties as AirportProperties).ident))
      if (hit) {
        const [lon, lat] = (hit.geometry as Point).coordinates
        drag.target = { airport: hit.properties as AirportProperties, at: [nearRoute(lon), lat] }
        setDragShape(drag.target.at, true)
      } else {
        drag.target = null
        setDragShape([nearRoute(event.lngLat.lng), event.lngLat.lat], false)
      }
    }

    const onDragEnd = () => {
      map.off('mousemove', onDragMove)
      map.dragPan.enable()
      map.getCanvas().style.cursor = ''
      const finished = drag
      if (!finished?.moving) return clearDrag.current()
      suppressClick = true
      setTimeout(() => (suppressClick = false), 0)
      if (!finished.target) return clearDrag.current()

      const { stop } = finished
      const { airport, at } = finished.target
      const { onEdit: edit, journey: current } = latest.current
      if (stop.role !== 'stop') {
        clearDrag.current()
        keepView.current = true
        edit({ kind: stop.role === 'origin' ? 'origin' : 'destination', ident: airport.ident })
        return
      }

      const points = [current.origin, ...current.legs.map((leg) => leg.to)]
      const own = new Set(current.via.map((v) => v.ident))
      const ownLater = points.slice(stop.index + 1, -1).filter((p) => own.has(p.ident)).length
      popup.current?.remove()
      const choice = new Popup({ maxWidth: '300px', closeOnClick: false }).setLngLat(at)
      choice.setDOMContent(
        choicePopup(stop.ident, airport, ownLater, (rest) => {
          keepView.current = true
          choice.remove()
          edit({ kind: 'drag', ident: stop.ident, withIdent: airport.ident, rest })
        })
      )
      choice.on('close', () => clearDrag.current())
      choice.addTo(map)
      popup.current = choice
    }

    map.on('mousedown', 'journey-stops-dots', (event) => {
      const feature = event.features?.find((f) => (f.properties as StopProperties).role)
      if (!feature) return
      event.preventDefault()
      map.dragPan.disable()
      const stop = feature.properties as StopProperties
      const coordinates = latest.current.data.stops.features.map((f) => f.geometry.coordinates as Coordinates)
      drag = {
        stop,
        start: event.point,
        previous: coordinates[stop.index - 1] ?? null,
        next: coordinates[stop.index + 1] ?? null,
        moving: false,
        target: null
      }
      map.getCanvas().style.cursor = 'grabbing'
      map.on('mousemove', onDragMove)
      window.addEventListener('mouseup', onDragEnd, { once: true })
    })
    map.on('mousemove', 'journey-stops-dots', (event) => {
      if (drag) return
      const draggable = event.features?.some((f) => (f.properties as StopProperties).role)
      map.getCanvas().style.cursor = draggable ? 'grab' : 'pointer'
    })
    map.on('mouseleave', 'journey-stops-dots', () => {
      if (!drag) map.getCanvas().style.cursor = ''
    })

    map.on('click', ({ point: { x, y } }) => {
      if (suppressClick || drag) return
      const [airport] = map.queryRenderedFeatures(
        [
          [x - CLICK_MARGIN_PX, y - CLICK_MARGIN_PX],
          [x + CLICK_MARGIN_PX, y + CLICK_MARGIN_PX]
        ],
        { layers: AIRPORT_DOT_LAYERS }
      )
      if (airport) openAirport(airport)
    })
    for (const layer of AIRPORT_DOT_LAYERS) {
      map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'))
      map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''))
    }

    // The panel changes size with the layout, so keep the whole route framed.
    const observer = new ResizeObserver(() => {
      map.resize()
      fit.current()
    })
    observer.observe(container.current)

    return () => {
      observer.disconnect()
      setReady(false)
      mapRef.current = null
      map.remove()
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const data = journeyMapData(journey)
    latest.current.data = data
    ;(map.getSource('journey-lines') as GeoJSONSource).setData(data.lines)
    ;(map.getSource('journey-stops') as GeoJSONSource).setData(data.stops)
    fit.current = () => map.fitBounds(data.bounds, { padding: 56, maxZoom: 9, animate: false })
    popup.current?.remove()
    clearDrag.current()
    if (!keepView.current) fit.current()
    keepView.current = false
  }, [journey, ready])

  if (failed) return <>{fallback}</>
  return (
    <div className="journey-map">
      <div ref={container} className="journey-map-canvas" role="region" aria-label={`Map of ${journey.name}`} />
      {journey.status === 'active' && (
        <p className="map-hint">Drag a stop onto another airport to change it. Zoom in for smaller airports.</p>
      )}
    </div>
  )
}
