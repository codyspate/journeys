import { useEffect, useState } from 'react'
import type { Arrival, CruiseHint, LegBrief, NavLogRow, ProfilePoint, Wind } from '../../shared/brief'
import type { Leg, RouteLimits } from '../../shared/journey'
import { errorText } from './errors'
import { clock } from './flightProgress'
import { feet } from './legNotes'

/** The pieces of a leg's briefing, shared by the Journey planner, the preflight briefing and the flight view. */

export const course = (deg: number) => `${String(deg).padStart(3, '0')}°`

/**
 * A leg's brief from the background process, fetched while `enabled`, again when the leg changes, and
 * every `refreshMs` if given (the wind in it is the wind at the aircraft now).
 */
export function useLegBrief(journeyId: string, leg: Leg, limits: RouteLimits, enabled = true, refreshMs?: number) {
  const [brief, setBrief] = useState<LegBrief | null>(null)
  const [error, setError] = useState<string | null>(null)
  const legKey = JSON.stringify([leg.id, leg.from.ident, leg.to.ident, leg.vorRoute?.map((f) => f.ident), limits])

  useEffect(() => {
    if (!enabled) return
    let current = true
    const load = () =>
      // Optional, so a window running against an older background process still works.
      Promise.resolve(window.journeys.legBrief?.(journeyId, leg.id))
        .then((b) => {
          if (!current) return
          setBrief(b ?? null)
          setError(null)
        })
        .catch((e) => current && setError(errorText(e)))
    void load()
    const timer = refreshMs ? setInterval(load, refreshMs) : null
    return () => {
      current = false
      if (timer) clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, journeyId, legKey, refreshMs])

  return { brief: brief?.legId === leg.id ? brief : null, error }
}

export function CruiseLine({ cruise, limits }: { cruise: CruiseHint; limits: RouteLimits }) {
  return (
    <>
      <p className="brief-line">
        <strong>Cruise {feet(cruise.suggestedFt)}</strong>
        <span className="muted">
          {' '}
          · VFR {cruise.eastbound ? 'eastbound, odd thousands plus 500' : 'westbound, even thousands plus 500'} ({course(cruise.courseDeg)}
          {cruise.magnetic ? ' magnetic' : ' true'}) · highest ground {feet(cruise.highestGroundFt)}
        </span>
      </p>
      {cruise.heldByCeiling && (
        <p className="note">
          Held under your {feet(limits.maxAltitudeFt ?? 0)} ceiling, so it doesn't clear the highest ground by your {feet(limits.terrainClearanceFt)}.
        </p>
      )}
    </>
  )
}

export function WindLine({ wind }: { wind: Wind | null }) {
  return (
    <p className="muted brief-line">
      {wind
        ? `Wind at your aircraft now: ${course(Math.round(wind.fromTrue) || 360)} true at ${Math.round(wind.kts)} kt. Headings, times and runways allow for it, roughly.`
        : 'Wind unknown until the sim is running, so headings and times are for still air.'}
    </p>
  )
}

/** The ground under the leg from the side, with the suggested cruise, your ceiling and, in flight, where you are. */
export function TerrainProfile({
  profile,
  totalNm,
  cruiseFt,
  ceilingFt,
  aircraft
}: {
  profile: ProfilePoint[]
  totalNm: number
  cruiseFt: number
  ceilingFt: number | null
  aircraft?: { alongNm: number; altFt: number } | null
}) {
  if (profile.length < 2) return <p className="muted">No terrain data for a profile.</p>
  const width = 600
  const height = 120
  const top = Math.max(cruiseFt, ceilingFt ?? 0, aircraft?.altFt ?? 0, ...profile.map((p) => p.groundFt)) * 1.1 || 1000
  const x = (nm: number) => (nm / (totalNm || 1)) * width
  const y = (ft: number) => height - (Math.max(0, ft) / top) * height
  const ground = [`0,${height}`, ...profile.map((p) => `${x(p.alongNm).toFixed(1)},${y(p.groundFt).toFixed(1)}`), `${width},${height}`].join(' ')
  return (
    <figure className="terrain-profile">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Terrain along the leg">
        <polygon points={ground} className="terrain-ground" />
        {profile
          .filter((p) => p.water)
          .map((p) => (
            <rect key={p.alongNm} x={x(p.alongNm) - 2} y={y(0) - 3} width={4} height={3} className="terrain-water" />
          ))}
        {ceilingFt !== null && <line x1={0} x2={width} y1={y(ceilingFt)} y2={y(ceilingFt)} className="terrain-ceiling" />}
        <line x1={0} x2={width} y1={y(cruiseFt)} y2={y(cruiseFt)} className="terrain-cruise" />
        {aircraft && <line x1={x(aircraft.alongNm)} x2={x(aircraft.alongNm)} y1={0} y2={height} className="terrain-aircraft" />}
        {aircraft && <circle cx={x(aircraft.alongNm)} cy={y(aircraft.altFt)} r={4} className="terrain-aircraft-dot" />}
      </svg>
      <figcaption className="muted">
        <span className="key key-cruise" /> Suggested cruise {feet(cruiseFt)}
        {ceilingFt !== null && (
          <>
            {' '}
            <span className="key key-ceiling" /> Your ceiling {feet(ceilingFt)}
          </>
        )}
        {aircraft && (
          <>
            {' '}
            <span className="key key-aircraft" /> You
          </>
        )}{' '}
        · {Math.round(totalNm)} nm
      </figcaption>
    </figure>
  )
}

export function checkpointName(row: NavLogRow) {
  if (row.kind === 'vor' || row.kind === 'ndb') return `${row.ident} ${row.frequency ?? ''} (${row.name}${row.kind === 'ndb' ? ' NDB' : ''})`
  if (row.kind === 'airport' || row.kind === 'arrival') return `${row.ident} ${row.name}`
  return row.name
}

/** The nav log as a kneeboard table. In flight, rows already passed fade and the next one is marked. */
export function NavLogTable({ rows, nextIndex = null }: { rows: NavLogRow[]; nextIndex?: number | null }) {
  return (
    <div className="nav-log-scroll">
      <table className="nav-log">
        <thead>
          <tr>
            <th>Checkpoint</th>
            <th>Crs</th>
            <th>Hdg</th>
            <th>Dist</th>
            <th>Total</th>
            <th>GS</th>
            <th>Time</th>
            <th>Elapsed</th>
            <th>Fuel</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              className={`nav-log-${row.kind}${nextIndex !== null && i < nextIndex ? ' passed' : ''}${i === nextIndex ? ' next' : ''}`}
              aria-current={i === nextIndex ? 'step' : undefined}
            >
              <td>{checkpointName(row)}</td>
              <td>{course(row.courseDeg)}</td>
              <td>{row.headingDeg === null ? '—' : course(row.headingDeg)}</td>
              <td>{Math.round(row.legNm)}</td>
              <td>{Math.round(row.totalNm)}</td>
              <td>{Math.round(row.gsKts)}</td>
              <td>{clock(row.legMinutes)}</td>
              <td>{clock(row.totalMinutes)}</td>
              <td>{row.fuelUsedGal.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** An airport at one end of the leg: elevation, pattern, and runways with the wind on each. */
export function AirportCard({ card, role, compact = false }: { card: Arrival; role: 'Departure' | 'Arrival'; compact?: boolean }) {
  return (
    <section className="airport-card" aria-label={`${role}: ${card.ident}`}>
      <h4>
        {role}: {card.ident} <span className="muted">{card.name}</span>
      </h4>
      <p>
        Field {feet(card.elevationFt)} · pattern about <strong>{feet(card.patternAltitudeFt)}</strong>
        {card.likely ? (
          <>
            {' '}
            · likely runway <strong>{card.likely}</strong> for the wind at your aircraft now
          </>
        ) : null}
      </p>
      {!compact &&
        (card.runways.length > 0 ? (
          <table className="nav-log arrival-runways">
            <thead>
              <tr>
                <th>Runway</th>
                <th>Length</th>
                <th>Surface</th>
                <th>Wind</th>
              </tr>
            </thead>
            <tbody>
              {card.runways.map((r) => (
                <tr key={r.ends.join('/')}>
                  <td>{r.ends.join('/')}</td>
                  <td>{feet(r.lengthFt)}</td>
                  <td>{r.hardSurface ? 'Paved' : 'Unpaved'}</td>
                  <td>
                    {r.windEnd === null || r.headwindKts === null
                      ? '—'
                      : `${r.windEnd}: ${Math.round(Math.abs(r.headwindKts))} kt ${r.headwindKts >= 0 ? 'head' : 'tail'}, ${Math.round(r.crosswindKts ?? 0)} kt cross`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No runways on record for this airport.</p>
        ))}
    </section>
  )
}

export const NAV_LOG_NOTE =
  'Courses are magnetic where Journeys knows the variation, distances in nm, fuel used since departure at your planned burn. Checkpoints are towns and airports near the line, so check them against the scenery.'
