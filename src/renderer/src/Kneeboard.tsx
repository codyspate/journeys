import { useEffect, useState } from 'react'
import type { LegBrief, NavLogRow, ProfilePoint } from '../../shared/brief'
import type { Leg, RouteLimits } from '../../shared/journey'
import { errorText } from './errors'
import { feet } from './legNotes'

const course = (deg: number) => `${String(deg).padStart(3, '0')}°`
const minutes = (m: number) => `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, '0')}`

/** The ground under the leg from the side, with the suggested cruise and your ceiling. */
function TerrainProfile({ profile, totalNm, cruiseFt, ceilingFt }: { profile: ProfilePoint[]; totalNm: number; cruiseFt: number; ceilingFt: number | null }) {
  if (profile.length < 2) return <p className="muted">No terrain data for a profile.</p>
  const width = 600
  const height = 120
  const top = Math.max(cruiseFt, ceilingFt ?? 0, ...profile.map((p) => p.groundFt)) * 1.1 || 1000
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
      </svg>
      <figcaption className="muted">
        <span className="key key-cruise" /> Suggested cruise {feet(cruiseFt)}
        {ceilingFt !== null && (
          <>
            {' '}
            <span className="key key-ceiling" /> Your ceiling {feet(ceilingFt)}
          </>
        )}{' '}
        · {Math.round(totalNm)} nm
      </figcaption>
    </figure>
  )
}

function checkpointName(row: NavLogRow) {
  if (row.kind === 'vor') return `${row.ident} ${row.frequency?.toFixed(2) ?? ''} (${row.name})`
  if (row.kind === 'airport' || row.kind === 'arrival') return `${row.ident} ${row.name}`
  return row.name
}

/** A kneeboard for one planned leg: cruise, terrain, checkpoints and the arrival. Suggestions only. */
export function Kneeboard({ journeyId, leg, limits, open = false }: { journeyId: string; leg: Leg; limits: RouteLimits; open?: boolean }) {
  const [shown, setShown] = useState(open)
  const [brief, setBrief] = useState<LegBrief | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Worked out again whenever the leg itself changes.
  const legKey = JSON.stringify([leg.id, leg.from.ident, leg.to.ident, leg.vorRoute?.map((f) => f.ident), limits])

  useEffect(() => {
    if (!shown) return
    let current = true
    setError(null)
    // Optional, so a window running against an older background process still works.
    Promise.resolve(window.journeys.legBrief?.(journeyId, leg.id))
      .then((b) => current && setBrief(b ?? null))
      .catch((e) => current && setError(errorText(e)))
    return () => {
      current = false
    }
  }, [shown, journeyId, legKey])

  return (
    <details className="kneeboard" open={shown} onToggle={(e) => setShown((e.target as HTMLDetailsElement).open)}>
      <summary>Kneeboard: cruise, terrain, checkpoints, arrival</summary>
      {error && <p className="error">{error}</p>}
      {shown && !brief && !error && <p className="muted">Working it out…</p>}
      {brief && brief.legId === leg.id && (
        <>
          <p>
            <strong>Cruise {feet(brief.cruise.suggestedFt)}</strong>
            <span className="muted">
              {' '}
              · VFR {brief.cruise.eastbound ? 'eastbound, odd thousands plus 500' : 'westbound, even thousands plus 500'} (
              {course(brief.cruise.courseDeg)}
              {brief.cruise.magnetic ? ' magnetic' : ' true'}) · highest ground {feet(brief.cruise.highestGroundFt)}
            </span>
          </p>
          {brief.cruise.heldByCeiling && (
            <p className="note">
              Held under your {feet(limits.maxAltitudeFt ?? 0)} ceiling, so it doesn't clear the highest ground by your{' '}
              {feet(limits.terrainClearanceFt)}.
            </p>
          )}
          <TerrainProfile profile={brief.profile} totalNm={brief.totalNm} cruiseFt={brief.cruise.suggestedFt} ceilingFt={limits.maxAltitudeFt} />

          <h4>Nav log</h4>
          <p className="muted">
            {brief.wind
              ? `Wind at your aircraft now: ${course(Math.round(brief.wind.fromTrue) || 360)} true at ${Math.round(brief.wind.kts)} kt. Headings and times allow for it, roughly.`
              : 'Wind unknown until the sim is running, so headings and times are for still air.'}
          </p>
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
                {brief.navLog.map((row, i) => (
                  <tr key={i} className={`nav-log-${row.kind}`}>
                    <td>{checkpointName(row)}</td>
                    <td>{course(row.courseDeg)}</td>
                    <td>{row.headingDeg === null ? '—' : course(row.headingDeg)}</td>
                    <td>{Math.round(row.legNm)}</td>
                    <td>{Math.round(row.totalNm)}</td>
                    <td>{Math.round(row.gsKts)}</td>
                    <td>{minutes(row.legMinutes)}</td>
                    <td>{minutes(row.totalMinutes)}</td>
                    <td>{row.fuelUsedGal.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted settings-note">
            Courses are magnetic where Journeys knows the variation, distances in nm, fuel used since departure at your planned burn.
            Checkpoints are towns and airports near the line, so check them against the scenery.
          </p>

          {brief.arrival && (
            <>
              <h4>
                Arrival: {brief.arrival.ident} {brief.arrival.name}
              </h4>
              <p>
                Field {feet(brief.arrival.elevationFt)} · pattern about <strong>{feet(brief.arrival.patternAltitudeFt)}</strong>
                {brief.arrival.likely && (
                  <>
                    {' '}
                    · likely runway <strong>{brief.arrival.likely}</strong> for the wind at your aircraft now
                  </>
                )}
              </p>
              {brief.arrival.runways.length > 0 ? (
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
                    {brief.arrival.runways.map((r) => (
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
              )}
            </>
          )}
        </>
      )}
    </details>
  )
}
