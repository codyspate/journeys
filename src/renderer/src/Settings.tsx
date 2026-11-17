import { useEffect, useState } from 'react'
import type { Settings as AppSettings } from '../../shared/airframe'
import { errorText } from './errors'
import { PhotoSettingsPanel } from './FlightJournal'
import { VersionSettings } from './Updates'
import { AssistantAccess, YourData } from './YourData'

function Toggle({
  checked,
  onChange,
  title,
  children
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  title: string
  children: React.ReactNode
}) {
  return (
    <label className="setting">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <strong>{title}</strong>
        {children}
      </span>
    </label>
  )
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="field small">
      <span>{label}</span>
      <input type="number" min={0} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

/** Saved together, so a half-typed number is never used. */
function DescentTiming({ settings, onSave }: { settings: AppSettings; onSave: (changes: Partial<AppSettings>) => Promise<void> }) {
  const [draft, setDraft] = useState(settings.descent)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setDraft(settings.descent), [settings.descent])
  const changed = JSON.stringify(draft) !== JSON.stringify(settings.descent)
  const set = (key: 'minutesBefore' | 'angleDeg' | 'arriveAboveFieldFt') => (value: number) => setDraft({ ...draft, [key]: value })
  return (
    <div className="descent-timing">
      <div className="fields">
        <NumberField label="Minutes before" value={draft.minutesBefore} onChange={set('minutesBefore')} />
        <NumberField label="Descent angle (°)" value={draft.angleDeg} onChange={set('angleDeg')} />
        <NumberField label="Level off above field (ft)" value={draft.arriveAboveFieldFt} onChange={set('arriveAboveFieldFt')} />
      </div>
      <p className="muted settings-note">3° is about 300 ft per nautical mile. The defaults are 2 minutes, 3° and 1,500 ft.</p>
      {changed && (
        <div className="save-actions">
          <button
            onClick={async () => {
              setError(null)
              try {
                await onSave({ descent: { ...draft, pauseBeforeTod: settings.descent.pauseBeforeTod } })
              } catch (e) {
                setError(errorText(e))
              }
            }}
          >
            Save timing
          </button>
          <button className="link" onClick={() => setDraft(settings.descent)}>
            Undo changes
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** Every app-wide setting in one place. Per-Journey options stay with each Journey's route settings. */
export function Settings() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  useEffect(() => {
    void window.journeys.getSettings().then(setSettings)
  }, [])
  const update = async (changes: Partial<AppSettings>) => {
    setSettings(await window.journeys.updateSettings(changes))
  }

  return (
    <section className="logbook settings-page">
      <h2>Settings</h2>
      {settings && (
        <>
          <h3>Aircraft</h3>
          <Toggle checked={settings.saveAircraftLocation} onChange={(on) => void update({ saveAircraftLocation: on })} title="Save aircraft location">
            <span className="muted">Remember where and how you parked each aircraft, and offer to bring it back.</span>
          </Toggle>
          <Toggle checked={settings.noTeleport} onChange={(on) => void update({ noTeleport: on })} title="No teleport">
            <span className="muted">
              Only log a flight when the aircraft takes off from where it last landed. Load it anywhere else and Journeys leaves that flight out
              until you bring the aircraft back, for example with Restore.
            </span>
            {!settings.noTeleport && (
              <span className="note" role="note">
                With this off, every flight is logged wherever it starts, so an aircraft's flight map can jump from place to place instead of
                drawing one continuous path. That can take away some of the sense of a journey.
              </span>
            )}
          </Toggle>

          <h3>Top of descent</h3>
          <Toggle
            checked={settings.descent.pauseBeforeTod}
            onChange={(on) => void update({ descent: { ...settings.descent, pauseBeforeTod: on } })}
            title="Pause the sim before top of descent"
          >
            <span className="muted">
              While you fly a leg of a Journey, Journeys works out where to start down to the next stop from your altitude and groundspeed, and
              pauses the sim this long before, once per leg. You can also switch it on and off from Home during a flight.
            </span>
          </Toggle>
          <DescentTiming settings={settings} onSave={update} />

          <h3>Maps</h3>
          <Toggle
            checked={settings.showUnfinishedFlights ?? false}
            onChange={(on) => void update({ showUnfinishedFlights: on })}
            title="Show unfinished flights on maps"
          >
            <span className="muted">
              Draw flights that ended before you landed and parked, such as ones ended from the sim's menu or cut off when the sim closed, on the
              Atlas and each aircraft's flight map. They're always listed in the Logbook either way.
            </span>
          </Toggle>
        </>
      )}

      <h3>Screenshots</h3>
      <PhotoSettingsPanel />

      <h3>AI assistants</h3>
      <AssistantAccess />

      <YourData />

      <h3>Version</h3>
      <VersionSettings />
    </section>
  )
}
