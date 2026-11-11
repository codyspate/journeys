import { useEffect, useState } from 'react'
import { type DescentSettings, type JourneySettings, type Performance, PERFORMANCE_PRESETS, type RouteLimits } from '../../shared/journey'
import { errorText } from './errors'

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="field small">
      <span>{label}</span>
      <input type="number" min={0} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

/** Blank means the limit is off. */
function OptionalField({ label, value, onChange }: { label: string; value: number | null; onChange: (value: number | null) => void }) {
  return (
    <label className="field small">
      <span>{label}</span>
      <input
        type="number"
        min={0}
        placeholder="Off"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    </label>
  )
}

let terrainAvailable: Promise<boolean> | null = null
function useTerrainAvailable(): boolean {
  const [available, setAvailable] = useState(true)
  useEffect(() => {
    terrainAvailable ??= window.journeys.hasTerrain()
    void terrainAvailable.then(setAvailable)
  }, [])
  return available
}

export function SettingsFields({ settings, onChange }: { settings: JourneySettings; onChange: (settings: JourneySettings) => void }) {
  const hasTerrain = useTerrainAvailable()
  const { performance, limits, descent } = settings
  const setDescent = (key: keyof DescentSettings) => (value: number | boolean) =>
    onChange({ ...settings, descent: { ...descent, [key]: value } })
  const setPerformance = (key: keyof Performance) => (value: number | boolean) =>
    onChange({ ...settings, performance: { ...performance, [key]: value } })
  const setLimit = (key: keyof RouteLimits) => (value: number | null) => onChange({ ...settings, limits: { ...limits, [key]: value } })
  const isPreset = PERFORMANCE_PRESETS.some((p) => p.name === performance.name)

  return (
    <>
      <h3>Aircraft</h3>
      <label className="field">
        <span>Starting numbers</span>
        <select
          value={isPreset ? performance.name : ''}
          onChange={(e) => {
            const preset = PERFORMANCE_PRESETS.find((p) => p.name === e.target.value)
            if (preset) onChange({ ...settings, performance: preset })
          }}
        >
          {!isPreset && <option value="">{performance.name}</option>}
          {PERFORMANCE_PRESETS.map((preset) => (
            <option key={preset.name}>{preset.name}</option>
          ))}
        </select>
      </label>
      <div className="fields">
        <NumberField label="Cruise (kt)" value={performance.cruiseKts} onChange={setPerformance('cruiseKts')} />
        <NumberField label="Burn (gal/h)" value={performance.burnGph} onChange={setPerformance('burnGph')} />
        <NumberField label="Usable fuel (gal)" value={performance.usableFuelGal} onChange={setPerformance('usableFuelGal')} />
        <NumberField label="Reserve (min)" value={performance.reserveMinutes} onChange={setPerformance('reserveMinutes')} />
        <NumberField label="Min runway (ft)" value={performance.minRunwayFt} onChange={setPerformance('minRunwayFt')} />
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={performance.needsHardSurface} onChange={(e) => setPerformance('needsHardSurface')(e.target.checked)} />
        Paved runways only
      </label>

      <h3>Legs</h3>
      <div className="fields">
        <NumberField label="Longest leg (min)" value={settings.maxLegMinutes} onChange={(maxLegMinutes) => onChange({ ...settings, maxLegMinutes })} />
        <OptionalField label="Longest leg (nm)" value={limits.maxLegNm} onChange={setLimit('maxLegNm')} />
        <OptionalField label="Shortest leg (nm)" value={limits.minLegNm} onChange={setLimit('minLegNm')} />
      </div>

      <h3>Terrain and water</h3>
      <div className="fields">
        <OptionalField label="Highest you'll fly (ft)" value={limits.maxAltitudeFt} onChange={setLimit('maxAltitudeFt')} />
        <NumberField
          label="Terrain clearance (ft)"
          value={limits.terrainClearanceFt}
          onChange={(value) => onChange({ ...settings, limits: { ...limits, terrainClearanceFt: value } })}
        />
        <OptionalField label="Highest airport (ft)" value={limits.maxAirportElevationFt} onChange={setLimit('maxAirportElevationFt')} />
        <OptionalField label="Longest water crossing (nm)" value={limits.maxWaterNm} onChange={setLimit('maxWaterNm')} />
      </div>
      <p className="muted settings-note">
        {hasTerrain
          ? 'Blank means off. Limits steer the suggested stops; you can still add any airport yourself. Terrain is the highest ground on the direct line, from a coarse world grid, so use it as a guide, not for clearance.'
          : 'Terrain data is missing from this install, so the highest altitude and water limits have no effect.'}
      </p>

      <h3>Top of descent</h3>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={descent.pauseBeforeTod}
          onChange={(e) => setDescent('pauseBeforeTod')(e.target.checked)}
        />
        Pause the sim before top of descent
      </label>
      <div className="fields">
        <NumberField label="Minutes before" value={descent.minutesBefore} onChange={setDescent('minutesBefore')} />
        <NumberField label="Descent angle (°)" value={descent.angleDeg} onChange={setDescent('angleDeg')} />
        <NumberField label="Level off above field (ft)" value={descent.arriveAboveFieldFt} onChange={setDescent('arriveAboveFieldFt')} />
      </div>
      <p className="muted settings-note">
        While you fly a leg of this Journey, Journeys works out where to start down to the next stop from your altitude and groundspeed,
        and pauses the sim this many minutes before, once per leg. 3° is about 300 ft per nautical mile.
      </p>
    </>
  )
}

/** The settings of an existing Journey, applied together so the route only re-plans once. */
export function RouteSettings({ settings, onApply }: { settings: JourneySettings; onApply: (settings: JourneySettings) => Promise<void> }) {
  const [draft, setDraft] = useState(settings)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setDraft(settings), [settings])
  const changed = JSON.stringify(draft) !== JSON.stringify(settings)

  return (
    <details className="route-settings">
      <summary>Route settings</summary>
      <SettingsFields settings={draft} onChange={setDraft} />
      <div className="save-actions">
        <button
          disabled={!changed}
          onClick={async () => {
            setError(null)
            try {
              await onApply(draft)
            } catch (e) {
              setError(errorText(e))
            }
          }}
        >
          Re-plan with these
        </button>
        {changed && (
          <button className="link" onClick={() => setDraft(settings)}>
            Undo changes
          </button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </details>
  )
}
