import { useEffect, useState } from 'react'
import type { RestoreOffer } from '../../shared/airframe'
import { errorText } from './errors'
import { restoreSummary as summary } from './RestoreResult'

export function RestoreBanner() {
  const [offer, setOffer] = useState<RestoreOffer | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    void window.journeys.getOffer().then(setOffer)
    return window.journeys.onOffer(setOffer)
  }, [])

  const restore = async () => {
    setBusy(true)
    setMessage(null)
    try {
      setMessage(summary(await window.journeys.acceptOffer()))
    } catch (e) {
      setMessage(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  if (busy) {
    return (
      <div className="banner" role="status">
        Bringing your aircraft back…
      </div>
    )
  }

  if (offer) {
    return (
      <div className="banner" role="status">
        <p>
          Your <strong>{offer.title}</strong> is parked
          {offer.location ? ` at ${offer.location.name} (${offer.location.ident})` : ' where you left it'}, last saved{' '}
          {new Date(offer.savedAt).toLocaleString()}.
        </p>
        <div className="banner-actions">
          <button onClick={restore}>Pick up where I left off</button>
          <button className="link" onClick={() => void window.journeys.declineOffer()}>
            Not this time
          </button>
        </div>
      </div>
    )
  }

  if (message) {
    return (
      <div className="banner" role="status">
        <p>{message}</p>
        <button className="link" onClick={() => setMessage(null)}>
          Dismiss
        </button>
      </div>
    )
  }

  return null
}
