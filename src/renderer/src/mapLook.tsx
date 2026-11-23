import type { Map as MapLibreMap } from 'maplibre-gl'
import { useSyncExternalStore } from 'react'
import { DEFAULT_SETTINGS, type MapStyleId, type Settings } from '../../shared/airframe'

/** How every map in the app looks: one of OpenFreeMap's styles, with or without shaded terrain. */
export interface MapLook {
  style: MapStyleId
  terrain: boolean
}

export const MAP_STYLES: { id: MapStyleId; label: string; url: string }[] = [
  { id: 'dark', label: 'Dark', url: 'https://tiles.openfreemap.org/styles/dark' },
  { id: 'light', label: 'Light', url: 'https://tiles.openfreemap.org/styles/positron' },
  { id: 'colorful', label: 'Colourful', url: 'https://tiles.openfreemap.org/styles/liberty' }
]

// Open elevation tiles on AWS (Mapzen's Terrain Tiles), free to use with credit.
const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
const TERRAIN_CREDIT = '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank">Terrain Tiles</a>'

let current: MapLook = { style: DEFAULT_SETTINGS.mapStyle, terrain: DEFAULT_SETTINGS.terrainShading }
const listeners = new Set<() => void>()
const lookOf = (settings: Partial<Settings>): MapLook => ({
  style: MAP_STYLES.some((s) => s.id === settings.mapStyle) ? settings.mapStyle! : DEFAULT_SETTINGS.mapStyle,
  terrain: settings.terrainShading ?? DEFAULT_SETTINGS.terrainShading
})
const publish = (look: MapLook) => {
  if (look.style === current.style && look.terrain === current.terrain) return
  current = look
  listeners.forEach((listener) => listener())
}

let loaded = false
const subscribe = (listener: () => void) => {
  if (!loaded) {
    loaded = true
    void window.journeys.getSettings().then((settings) => publish(lookOf(settings)))
  }
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The current look. Maps are drawn again from scratch when it changes. */
export const useMapLook = () => useSyncExternalStore(subscribe, () => current)

/** A key that changes with the look, so a map remounts with the new style. */
export const lookKey = (look: MapLook) => `${look.style}-${look.terrain ? 'terrain' : 'flat'}`

/** Saves a new look app-wide and redraws every map. */
export async function setMapLook(changes: Partial<MapLook>): Promise<Settings> {
  const next = { ...current, ...changes }
  const settings = await window.journeys.updateSettings({ mapStyle: next.style, terrainShading: next.terrain })
  publish(lookOf(settings))
  return settings
}

/** Light and colourful styles both want dark labels with light halos. */
export const isLightMap = (look: MapLook = current) => look.style !== 'dark'

export const styleUrl = (look: MapLook = current) => (MAP_STYLES.find((s) => s.id === look.style) ?? MAP_STYLES[0]).url

/** Adds shaded hills under the map's labels and roads, when terrain shading is on. Call once the style has loaded. */
export function shadeTerrain(map: MapLibreMap, look: MapLook = current): void {
  if (!look.terrain) return
  map.addSource('terrain-dem', { type: 'raster-dem', tiles: [TERRAIN_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 15, attribution: TERRAIN_CREDIT })
  // Under the first road or label, so the shading sits on the land and water but not over names.
  const beneath = map.getStyle().layers.find((layer) => layer.type === 'symbol' || layer.id.includes('road') || layer.id.includes('highway'))?.id
  const dark = look.style === 'dark'
  map.addLayer(
    {
      id: 'terrain-shading',
      type: 'hillshade',
      source: 'terrain-dem',
      paint: {
        'hillshade-exaggeration': dark ? 0.45 : 0.35,
        'hillshade-shadow-color': dark ? '#000000' : '#5a5a5a',
        'hillshade-highlight-color': dark ? '#5d6b82' : '#ffffff',
        'hillshade-accent-color': dark ? '#000000' : '#6b6b6b'
      }
    },
    beneath
  )
}

/** A small picker on each map, for changing every map's look without going to Settings. */
export function MapStyleSwitch() {
  const look = useMapLook()
  return (
    <div className="map-style-switch">
      <select aria-label="Map style" value={look.style} onChange={(e) => void setMapLook({ style: e.target.value as MapStyleId })}>
        {MAP_STYLES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      <label title="Shade hills and mountains">
        <input type="checkbox" checked={look.terrain} onChange={(e) => void setMapLook({ terrain: e.target.checked })} />
        Terrain
      </label>
    </div>
  )
}
