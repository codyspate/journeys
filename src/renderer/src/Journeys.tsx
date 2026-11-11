import { useEffect, useId, useMemo, useState } from 'react'
import {
  type Airport,
  DEFAULT_DESCENT,
  type Journey,
  type JourneySettings,
  type Leg,
  NO_LIMITS,
  PERFORMANCE_PRESETS,
  type ReachOptions,
  type RouteEdit,
  type RouteLimits
} from '../../shared/journey'
import type { FlightJournal } from '../../shared/logbook'
import { errorText } from './errors'
import { JourneyMap } from './JourneyMap'
import { feet, legNotes, MENTION_WATER_NM } from './legNotes'
import { RouteSettings, SettingsFields } from './RouteSettings'
import { SaveControls } from './SaveControls'

const hoursMinutes = (minutes: number) => {
  const total = Math.round(minutes)
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`
}

/** What another screen wants the Journeys tab to do when it opens. */
export type JourneyRequest = { kind: 'open'; id: string } | { kind: 'plan'; from?: string; to?: string }

export function AirportInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const listId = useId()
  const [results, setResults] = useState<Airport[]>([])

  useEffect(() => {
    let current = true
    const timer = setTimeout(() => {
      void window.journeys.searchAirports(value).then((found) => current && setResults(found))
    }, 120)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [value])

  return (
    <label className="field">
      <span>{label}</span>
      <input list={listId} placeholder="ICAO, city or name" value={value} onChange={(e) => onChange(e.target.value)} />
      <datalist id={listId}>
        {results.map((airport) => (
          <option key={airport.ident} value={airport.ident}>
            {airport.name}, {airport.city}
            {airport.codes?.length ? ` (${airport.codes.join(', ')})` : ''}
          </option>
        ))}
      </datalist>
    </label>
  )
}

function NewJourney({ onCreated, from = '', to = '' }: { onCreated: (journey: Journey) => void; from?: string; to?: string }) {
  const [name, setName] = useState('')
  const [origin, setOrigin] = useState(from)
  const [destination, setDestination] = useState(to)
  const [settings, setSettings] = useState<JourneySettings>({
    performance: PERFORMANCE_PRESETS[0],
    maxLegMinutes: 180,
    limits: NO_LIMITS,
    descent: DEFAULT_DESCENT
  })
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    setError(null)
    try {
      onCreated(
        await window.journeys.createJourney({
          name,
          originIdent: origin,
          destinationIdent: destination,
          ...settings
        })
      )
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <div className="new-journey">
      <h2>Plan a Journey</h2>
      <label className="field">
        <span>Name (optional)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="fields">
        <AirportInput label="From" value={origin} onChange={setOrigin} />
        <AirportInput label="To" value={destination} onChange={setDestination} />
      </div>
      <SettingsFields settings={settings} onChange={setSettings} />
      <p className="muted">Starting numbers are estimates. Adjust them to match how you fly. You can change all of this later.</p>
      <button onClick={create} disabled={!origin || !destination}>
        Plan it
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function RouteSketch({ journey }: { journey: Journey }) {
  const points = [journey.origin, ...journey.legs.map((leg) => leg.to)]
  const lats = points.map((p) => p.lat)
  const lons = points.map((p) => p.lon)
  const [minLat, maxLat, minLon, maxLon] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)]
  const scale = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180)
  const spanX = Math.max((maxLon - minLon) * scale, 0.5)
  const spanY = Math.max(maxLat - minLat, 0.5)
  const unit = Math.min(680 / spanX, 140 / spanY)
  const x = (lon: number) => 20 + (lon - minLon) * scale * unit
  const y = (lat: number) => 20 + (maxLat - lat) * unit
  const height = spanY * unit + 40

  return (
    <svg className="sketch" viewBox={`0 0 ${spanX * unit + 40} ${height}`} role="img" aria-label={`Route of ${journey.name}`}>
      {journey.legs.map((leg) => (
        <line
          key={leg.id}
          x1={x(leg.from.lon)}
          y1={y(leg.from.lat)}
          x2={x(leg.to.lon)}
          y2={y(leg.to.lat)}
          className={leg.status === 'flown' ? 'flown' : leg.confidence}
        />
      ))}
      {points.map((point, i) => (
        <circle key={`${point.ident}-${i}`} cx={x(point.lon)} cy={y(point.lat)} r={4} />
      ))}
    </svg>
  )
}

function ChangeAirport({ label, onSave, onCancel }: { label: string; onSave: (ident: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState('')
  return (
    <div className="fields leg-change">
      <AirportInput label={label} value={value} onChange={setValue} />
      <button disabled={!value} onClick={() => onSave(value)}>
        Save
      </button>
      <button className="link" onClick={onCancel}>
        Cancel
      </button>
    </div>
  )
}

interface LegEditing {
  isDestination: boolean
  /** Where this stop sits in the player's own stops, or -1 if the planner chose it. */
  chosenIndex: number
  chosenCount: number
  changing: boolean
  onStartChange: () => void
  onCancelChange: () => void
  onEdit: (edit: RouteEdit) => void
}

function LegActions({ leg, editing }: { leg: Leg; editing: LegEditing }) {
  const { isDestination, chosenIndex, chosenCount, changing, onStartChange, onCancelChange, onEdit } = editing
  const ident = leg.to.ident
  if (changing) {
    return (
      <ChangeAirport
        label={isDestination ? 'New destination' : `Stop instead of ${ident}`}
        onCancel={onCancelChange}
        onSave={(next) => onEdit(isDestination ? { kind: 'destination', ident: next } : { kind: 'replace', ident, withIdent: next })}
      />
    )
  }
  return (
    <div className="leg-actions">
      <button className="link" onClick={onStartChange}>
        Change
      </button>
      {!isDestination && (
        <button className="link" onClick={() => onEdit({ kind: 'remove', ident })}>
          Remove
        </button>
      )}
      {chosenIndex > 0 && (
        <button className="link" onClick={() => onEdit({ kind: 'move', ident, offset: -1 })}>
          Earlier
        </button>
      )}
      {chosenIndex >= 0 && chosenIndex < chosenCount - 1 && (
        <button className="link" onClick={() => onEdit({ kind: 'move', ident, offset: 1 })}>
          Later
        </button>
      )}
    </div>
  )
}

function LegRow({ leg, limits, editing, journal }: { leg: Leg; limits: RouteLimits; editing: LegEditing | null; journal?: FlightJournal }) {
  const chosen = editing !== null && editing.chosenIndex >= 0
  return (
    <li className={`leg ${leg.status} ${leg.confidence}`}>
      <div>
        <strong>
          {leg.from.ident} → {leg.to.ident}
        </strong>
        <span className="muted">{leg.to.name}</span>
      </div>
      <div className="leg-stats">
        <span>{Math.round(leg.distanceNm)} nm</span>
        <span>{hoursMinutes(leg.minutes)}</span>
        <span>{leg.fuelGal.toFixed(0)} gal</span>
        {leg.highestTerrainFt != null && <span>Highest ground {feet(leg.highestTerrainFt)}</span>}
        {leg.longestWaterNm != null && leg.longestWaterNm >= MENTION_WATER_NM && <span>{Math.round(leg.longestWaterNm)} nm over water</span>}
        <span className="tag">
          {leg.status === 'flown' ? 'Flown' : chosen ? 'Your stop' : leg.confidence === 'firm' ? 'Planned' : 'Tentative'}
        </span>
      </div>
      {leg.status === 'planned' &&
        legNotes(leg, limits).map((note) => (
          <p key={note} className="note">
            {note}
          </p>
        ))}
      {journal?.note && <p className="leg-journal">“{journal.note}”</p>}
      {journal && journal.photoCount > 0 && (
        <p className="muted">
          {journal.photoCount} {journal.photoCount === 1 ? 'photo' : 'photos'} in the Logbook
        </p>
      )}
      {editing && <LegActions leg={leg} editing={editing} />}
    </li>
  )
}

function ReachBanner({ reach, onAccept }: { reach: ReachOptions; onAccept: (ident: string) => void }) {
  const choice = reach.further ?? reach.closer
  return (
    <div className="reach" role="status">
      <p>
        {reach.plannedStop.ident} is {Math.round(reach.distanceToPlannedNm)} nm away, arriving with{' '}
        {Math.max(0, Math.round(reach.reserveAtPlannedMinutes))} min of fuel.
      </p>
      {choice && (
        <p>
          <strong>{choice.stop.name}</strong> ({choice.stop.ident}) is {reach.further ? 'also in reach' : 'an option'},{' '}
          {Math.round(choice.distanceNm)} nm away with {Math.max(0, Math.round(choice.reserveMinutes))} min of fuel.{' '}
          <button className="link" onClick={() => onAccept(choice.stop.ident)}>
            Make it my next stop
          </button>
        </p>
      )}
    </div>
  )
}

export function Journeys({ request = null, onHandled }: { request?: JourneyRequest | null; onHandled?: () => void } = {}) {
  // A new Journey asked for from Home, with its airports filled in.
  const [plan, setPlan] = useState<{ from?: string; to?: string; key: number }>({ key: 0 })
  const [journeys, setJourneys] = useState<Journey[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reach, setReach] = useState<ReachOptions | null>(null)
  const [stop, setStop] = useState('')
  const [changing, setChanging] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const selected = useMemo(() => journeys.find((j) => j.id === selectedId) ?? null, [journeys, selectedId])
  // Notes and photo counts for the flights already flown on the open Journey.
  const [journals, setJournals] = useState<Record<string, FlightJournal>>({})
  const flownIds = selected?.legs.flatMap((leg) => (leg.flightId ? [leg.flightId] : [])).join(',') ?? ''
  useEffect(() => {
    if (!flownIds) return setJournals({})
    void window.journeys.flightJournals?.(flownIds.split(',')).then(setJournals)
  }, [flownIds])
  const settings = useMemo<JourneySettings | null>(
    () =>
      selected
        ? { performance: selected.performance, maxLegMinutes: selected.maxLegMinutes, limits: selected.limits, descent: selected.descent }
        : null,
    // Rebuilt only when the numbers change, so a draft survives unrelated updates such as a flight landing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected && JSON.stringify([selected.performance, selected.maxLegMinutes, selected.limits, selected.descent])]
  )

  const replace = (journey: Journey) =>
    setJourneys((all) => (all.some((j) => j.id === journey.id) ? all.map((j) => (j.id === journey.id ? journey : j)) : [journey, ...all]))

  useEffect(() => {
    void window.journeys.listJourneys().then(setJourneys)
    const offReach = window.journeys.onReach(setReach)
    const offUpdated = window.journeys.onJourneyUpdated(replace)
    return () => {
      offReach()
      offUpdated()
    }
  }, [])

  const run = async (action: () => Promise<Journey>) => {
    setError(null)
    try {
      replace(await action())
    } catch (e) {
      setError(errorText(e))
    }
  }

  const open = (journey: Journey) => {
    setSelectedId(journey.id)
    setChanging(null)
    void run(() => window.journeys.openJourney(journey.id))
  }

  // Arriving from Home: open the Journey picked there once the list has loaded, or start planning one.
  useEffect(() => {
    if (!request) return
    if (request.kind === 'plan') {
      setSelectedId(null)
      setPlan((current) => ({ from: request.from, to: request.to, key: current.key + 1 }))
      onHandled?.()
      return
    }
    const target = journeys.find((j) => j.id === request.id)
    if (!target) return
    open(target)
    onHandled?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, journeys])

  const edit = (change: RouteEdit) => {
    if (!selected) return
    const { id } = selected
    setChanging(null)
    void run(() => window.journeys.editRoute(id, change))
  }

  const legEditing = (journey: Journey, leg: Leg): LegEditing | null =>
    journey.status === 'active' && leg.status === 'planned'
      ? {
          isDestination: leg.to.ident === journey.destination.ident,
          chosenIndex: journey.via.findIndex((v) => v.ident === leg.to.ident),
          chosenCount: journey.via.length,
          changing: changing === leg.to.ident,
          onStartChange: () => setChanging(leg.to.ident),
          onCancelChange: () => setChanging(null),
          onEdit: edit
        }
      : null

  const planned = selected?.legs.filter((leg) => leg.status === 'planned') ?? []
  const canChangeOrigin = selected?.status === 'active' && selected.legs.every((leg) => leg.status === 'planned')
  const remainingNm = planned.reduce((sum, leg) => sum + leg.distanceNm, 0)
  const remainingMinutes = planned.reduce((sum, leg) => sum + leg.minutes, 0)

  return (
    <main className="journeys">
      <section className="column">
        <button className="wide-button" onClick={() => setSelectedId(null)}>
          New Journey
        </button>
        <h2>Your Journeys</h2>
        {journeys.length === 0 && <p className="muted">Nothing planned yet.</p>}
        <ul className="snapshots">
          {journeys.map((journey) => (
            <li key={journey.id}>
              <button className={journey.id === selectedId ? 'item selected' : 'item'} onClick={() => open(journey)}>
                <strong>{journey.name}</strong>
                <span className="muted">
                  {journey.legs.filter((l) => l.status === 'flown').length} of {journey.legs.length} legs flown
                  {journey.status === 'complete' ? ' · complete' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className={selected ? 'column wide fills' : 'column wide'}>
        {!selected && (
          <NewJourney
            key={plan.key}
            from={plan.from}
            to={plan.to}
            onCreated={(journey) => {
              replace(journey)
              setSelectedId(journey.id)
            }}
          />
        )}
        {selected && (
          <div className="journey-detail">
            <div className="journey-head">
              <h2>{selected.name}</h2>
              <SaveControls
                key={selected.id}
                name={selected.name}
                placeholder={`${selected.origin.ident} to ${selected.destination.ident}`}
                deleteQuestion="Delete this Journey? Your logbook flights stay."
                onRename={async (name) => replace(await window.journeys.renameJourney(selected.id, name))}
                onDelete={async () => {
                  const { id } = selected
                  await window.journeys.deleteJourney(id)
                  setJourneys((all) => all.filter((j) => j.id !== id))
                  setReach((current) => (current?.journeyId === id ? null : current))
                  setSelectedId(null)
                }}
              />
              <p className="muted">
                {selected.performance.name} · {planned.length} legs left · {Math.round(remainingNm)} nm ·{' '}
                {hoursMinutes(remainingMinutes)} at cruise, still air
              </p>

              {reach?.journeyId === selected.id && (
                <ReachBanner reach={reach} onAccept={(ident) => edit({ kind: 'add', ident })} />
              )}
            </div>

            <div className="journey-map-area">
              <JourneyMap
                journey={selected}
                fallback={<RouteSketch journey={selected} />}
                onEdit={edit}
              />
            </div>

            <div className="journey-plan">
            {canChangeOrigin && (
              <div className="leg">
                <div>
                  <strong>Departing {selected.origin.ident}</strong>
                  <span className="muted">{selected.origin.name}</span>
                </div>
                {changing === 'origin' ? (
                  <ChangeAirport
                    label="New departure"
                    onCancel={() => setChanging(null)}
                    onSave={(ident) => edit({ kind: 'origin', ident })}
                  />
                ) : (
                  <div className="leg-actions">
                    <button className="link" onClick={() => setChanging('origin')}>
                      Change
                    </button>
                  </div>
                )}
              </div>
            )}
            <ol className="legs">
              {selected.legs.map((leg) => (
                <LegRow
                  key={leg.id}
                  leg={leg}
                  limits={selected.limits}
                  editing={legEditing(selected, leg)}
                  journal={leg.flightId ? journals[leg.flightId] : undefined}
                />
              ))}
            </ol>

            {selected.status === 'active' && (
              <div className="fields controls">
                <AirportInput label="Add a stop" value={stop} onChange={setStop} />
                <button
                  disabled={!stop}
                  onClick={() => {
                    edit({ kind: 'add', ident: stop })
                    setStop('')
                  }}
                >
                  Add
                </button>
                {(selected.via.length > 0 || selected.avoid.length > 0) && (
                  <button className="link" onClick={() => edit({ kind: 'reset' })}>
                    Go back to the suggested route
                  </button>
                )}
              </div>
            )}
            {selected.status === 'active' && (
              <RouteSettings
                key={selected.id}
                settings={settings!}
                onApply={async (next) => replace(await window.journeys.updateJourneySettings(selected.id, next))}
              />
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            </div>
          </div>
        )}
      </section>
    </main>
  )
}
