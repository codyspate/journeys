import { useEffect, useState } from 'react'
import { errorText } from './errors'
import type { TopOfDescent } from '../../shared/journey'

const feet = (value: number) => `${(Math.round(value / 100) * 100).toLocaleString()} ft`

/** Explains why the sim just paused, with the numbers needed to set up the descent. */
export function DescentBanner() {
  const [tod, setTod] = useState<TopOfDescent | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Optional so a window reloaded during development against an older background process still works.
  useEffect(() => window.journeys.onDescentPause?.((next) => (setError(null), setTod(next))), [])
  if (!tod) return null
  const resume = () =>
    window.journeys.resumeSim().then(
      () => setTod(null),
      (e) => setError(errorText(e))
    )
  const minutes = Math.max(0, tod.minutesToTod)
  return (
    <div className="banner" role="alert">
      <p>
        <strong>Paused for your descent into {tod.ident}.</strong> Top of descent is about{' '}
        {minutes < 1 ? 'less than a minute' : `${Math.round(minutes)} min`} ahead, {Math.round(tod.descentNm)} nm out from {tod.name}.
        Descend from {feet(tod.fromAltFt)} to {feet(tod.toAltFt)}. Resume when you're ready.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="banner-actions">
        <button onClick={() => void resume()}>Resume flight</button>
        <button className="link" onClick={() => setTod(null)}>
          Dismiss
        </button>
      </div>
    </div>
  )
}
