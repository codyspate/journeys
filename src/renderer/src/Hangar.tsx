import { useCallback, useEffect, useState } from 'react'
import type { AirframeRecord, AirframeSave, Settings } from '../../shared/airframe'
import { profileById } from '../../shared/catalog'
import { type Category, CATEGORIES, type PositionMethod, type RestoreOptions, type RestoreReport, type Snapshot } from '../../shared/types'
import { AircraftMap } from './AircraftMap'
import { errorText } from './errors'
import { RestoreResult } from './RestoreResult'
import { SaveControls } from './SaveControls'

const REFRESH_MS = 5000

function totalFuel(snapshot: Snapshot): number {
  return Object.entries(snapshot.values).reduce(
    (sum, [id, value]) => (id.startsWith('fuel.') && id !== 'fuel.selector1' ? sum + (value ?? 0) : sum),
    0
  )
}

const placeOf = (location: AirframeSave['location']) => (location ? `${location.name} (${location.ident})` : 'Away from an airport')

/** What a restore brings back and how the aircraft is moved. The lab's choices, now per aircraft. */
function RestoreChoices({ options, onChange }: { options: RestoreOptions; onChange: (options: RestoreOptions) => void }) {
  const toggle = (category: Category) =>
    onChange({
      ...options,
      categories: options.categories.includes(category) ? options.categories.filter((c) => c !== category) : [...options.categories, category]
    })
  const method = (positionMethod: PositionMethod) => onChange({ ...options, positionMethod })
  return (
    <details className="restore-choices">
      <summary>Restore options</summary>
      <fieldset>
        <legend>What to restore</legend>
        {CATEGORIES.map((category) => (
          <label key={category}>
            <input type="checkbox" checked={options.categories.includes(category)} onChange={() => toggle(category)} />
            {category}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>How to move the aircraft</legend>
        <label>
          <input type="radio" checked={options.positionMethod === 'initposition'} onChange={() => method('initposition')} />
          Initial Position
        </label>
        <label>
          <input type="radio" checked={options.positionMethod === 'simvars'} onChange={() => method('simvars')} />
          Position variables
        </label>
      </fieldset>
    </details>
  )
}

function History({
  record,
  loaded,
  busy,
  onRestore,
  refreshKey
}: {
  record: AirframeRecord
  loaded: boolean
  busy: boolean
  onRestore: (saveId: string) => void
  refreshKey: number
}) {
  const [saves, setSaves] = useState<AirframeSave[] | null>(null)
  useEffect(() => {
    void window.journeys.airframeHistory(record.key).then(setSaves)
  }, [record.key, refreshKey])

  if (!saves) return null
  if (saves.length === 0) return <p className="muted">No earlier saves yet.</p>
  return (
    <ul className="history">
      {saves.map((save) => (
        <li key={save.id}>
          <div className="history-line">
            <strong>{save.name}</strong>
            <span className="tag">{save.kind === 'manual' ? 'Saved' : 'Parked'}</span>
          </div>
          <span className="muted">
            {placeOf(save.location)} · {totalFuel(save.snapshot).toFixed(1)} gal · {new Date(save.snapshot.capturedAt).toLocaleString()}
            {save.snapshot.parked ? '' : ' · not parked'}
          </span>
          <div className="save-actions">
            <button className="link" disabled={!loaded || busy} onClick={() => onRestore(save.id)}>
              Restore
            </button>
            <SaveControls
              name={save.name}
              deleteQuestion="Delete this save?"
              onRename={async (name) => {
                const renamed = await window.journeys.renameAirframeSave(save.id, name)
                setSaves((all) => all?.map((s) => (s.id === renamed.id ? renamed : s)) ?? null)
              }}
              onDelete={async () => {
                await window.journeys.deleteAirframeSave(save.id)
                setSaves((all) => all?.filter((s) => s.id !== save.id) ?? null)
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

function AircraftCard({
  record,
  loaded,
  onChanged,
  onDeleted
}: {
  record: AirframeRecord
  loaded: boolean
  onChanged: (record: AirframeRecord) => void
  onDeleted: () => void
}) {
  const [showHistory, setShowHistory] = useState(false)
  const [showFlights, setShowFlights] = useState(false)
  const [busy, setBusy] = useState<'save' | 'restore' | null>(null)
  const [report, setReport] = useState<RestoreReport | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [options, setOptions] = useState<RestoreOptions>(() => ({
    categories: profileById(record.snapshot.profileId).restore,
    positionMethod: 'initposition'
  }))

  const act = async (kind: 'save' | 'restore', action: () => Promise<void>) => {
    setBusy(kind)
    setError(null)
    setMessage(null)
    setReport(null)
    try {
      await action()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const save = () =>
    act('save', async () => {
      const saved = await window.journeys.saveAirframe(record.key, '')
      onChanged({ ...record, snapshot: saved.snapshot, location: saved.location })
      setMessage(`Saved as “${saved.name}”. You can rename it in History.`)
      setHistoryVersion((v) => v + 1)
    })

  const restore = (saveId: string | null) =>
    act('restore', async () => {
      setReport(await window.journeys.restoreAirframe(record.key, saveId, options))
    })

  const title = record.nickname ?? record.snapshot.aircraft.title
  return (
    <li className="item aircraft">
      <div className="history-line">
        <strong>{title}</strong>
        {loaded && <span className="tag loaded">In the sim now</span>}
      </div>
      <span>{placeOf(record.location)}</span>
      <span className="muted">
        {record.nickname ? `${record.snapshot.aircraft.title} · ` : ''}
        {record.snapshot.aircraft.livery} · {totalFuel(record.snapshot).toFixed(1)} gal · last saved{' '}
        {new Date(record.snapshot.capturedAt).toLocaleString()}
      </span>
      <SaveControls
        name={record.nickname ?? ''}
        placeholder={record.snapshot.aircraft.title}
        deleteQuestion="Forget this aircraft and all of its saves?"
        onRename={async (nickname) => onChanged(await window.journeys.renameAirframe(record.key, nickname))}
        onDelete={async () => {
          await window.journeys.deleteAirframe(record.key)
          onDeleted()
        }}
      />

      <div className="card-actions">
        <button disabled={!loaded || busy !== null} onClick={save}>
          {busy === 'save' ? 'Saving…' : 'Save now'}
        </button>
        <button disabled={!loaded || busy !== null} onClick={() => restore(null)}>
          {busy === 'restore' ? 'Restoring…' : 'Restore'}
        </button>
        <button className="secondary" aria-expanded={showHistory} onClick={() => setShowHistory((open) => !open)}>
          {showHistory ? 'Hide history' : 'History'}
        </button>
        <button className="secondary" aria-expanded={showFlights} onClick={() => setShowFlights((open) => !open)}>
          {showFlights ? 'Hide flights' : 'Flights'}
        </button>
      </div>
      {!loaded && <p className="muted">Load this aircraft in the sim to save or restore it.</p>}

      {message && <p className="note">{message}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {report && <RestoreResult report={report} onDismiss={() => setReport(null)} />}

      {showFlights && (
        <div className="history-panel">
          <AircraftMap airframeKey={record.key} />
        </div>
      )}

      {showHistory && (
        <div className="history-panel">
          <RestoreChoices options={options} onChange={setOptions} />
          <History record={record} loaded={loaded} busy={busy !== null} onRestore={restore} refreshKey={historyVersion} />
        </div>
      )}
    </li>
  )
}

/** The loaded aircraft before it has ever been saved. */
function NewAircraft({ loadedKey, onSaved }: { loadedKey: string; onSaved: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [title, livery] = loadedKey.split('|')
  return (
    <div className="reach">
      <p>
        <strong>{title}</strong>
        {livery ? ` (${livery})` : ''} is in the sim but not in your hangar yet. It's added automatically once you park it.
      </p>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError(null)
          try {
            await window.journeys.saveAirframe(loadedKey, '')
            onSaved()
          } catch (e) {
            setError(errorText(e))
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? 'Saving…' : 'Save it now'}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export function Hangar() {
  const [airframes, setAirframes] = useState<AirframeRecord[] | null>(null)
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)

  const load = useCallback(() => {
    void window.journeys.listAirframes().then(setAirframes)
    void window.journeys.loadedAirframe().then(setLoadedKey)
  }, [])

  useEffect(() => {
    load()
    void window.journeys.getSettings().then(setSettings)
    const timer = setInterval(load, REFRESH_MS)
    const offStatus = window.journeys.onStatus(load)
    return () => {
      clearInterval(timer)
      offStatus()
    }
  }, [load])

  return (
    <section className="logbook">
      <h2>Hangar</h2>
      {settings && (
        <p className="muted">
          Saving aircraft location is {settings.saveAircraftLocation ? 'on' : 'off'} and No teleport is {settings.noTeleport ? 'on' : 'off'}. Change
          them in Settings.
        </p>
      )}

      {airframes && loadedKey && !airframes.some((record) => record.key === loadedKey) && (
        <NewAircraft loadedKey={loadedKey} onSaved={load} />
      )}
      {airframes?.length === 0 && <p className="muted">Park an aircraft and it will appear here.</p>}
      {airframes && airframes.length > 0 && (
        <ul className="snapshots hangar">
          {airframes.map((record) => (
            <AircraftCard
              key={record.key}
              record={record}
              loaded={record.key === loadedKey}
              onChanged={(changed) => setAirframes((all) => all?.map((r) => (r.key === changed.key ? changed : r)) ?? null)}
              onDeleted={() => setAirframes((all) => all?.filter((r) => r.key !== record.key) ?? null)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
