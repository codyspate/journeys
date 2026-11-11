import { useEffect, useState } from 'react'
import type { Settings as AppSettings } from '../../shared/airframe'
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

/** Every app-wide setting in one place. Per-Journey options stay with each Journey's route settings. */
export function Settings() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  useEffect(() => {
    void window.journeys.getSettings().then(setSettings)
  }, [])
  const update = async (changes: Partial<AppSettings>) => setSettings(await window.journeys.updateSettings(changes))

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
