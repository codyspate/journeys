import { useEffect, useState } from 'react'
import type { SimStatus } from '../../shared/types'
import { DescentBanner } from './DescentBanner'
import { Hangar } from './Hangar'
import { Home } from './Home'
import { type JourneyRequest, Journeys } from './Journeys'
import { Logbook } from './Logbook'
import { RestoreBanner } from './RestoreBanner'
import { Settings } from './Settings'
import { UntrackedBanner } from './UntrackedBanner'
import { UpdateBanner } from './Updates'

type View = 'home' | 'journeys' | 'logbook' | 'hangar' | 'settings'
const VIEWS: { id: View; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'journeys', label: 'Journeys' },
  { id: 'logbook', label: 'Logbook' },
  { id: 'hangar', label: 'Hangar' },
  { id: 'settings', label: 'Settings' }
]

export function App() {
  const [view, setView] = useState<View>('home')
  // What Home asked the Journeys tab to do: open a Journey, or start planning one.
  const [journeyRequest, setJourneyRequest] = useState<JourneyRequest | null>(null)
  const [status, setStatus] = useState<SimStatus>({ connected: false, simName: null })

  useEffect(() => {
    void window.journeys.getStatus().then(setStatus)
    // Just restored from a backup: open where the restore notice is.
    void window.journeys.restoredFrom?.().then((setAside) => setAside && setView('settings'))
    return window.journeys.onStatus(setStatus)
  }, [])

  return (
    <div className="app">
      <header>
        <div className="brand">
          <h1>Journeys</h1>
          <nav aria-label="Sections">
            {VIEWS.map(({ id, label }) => (
              <button key={id} className={view === id ? 'tab active' : 'tab'} onClick={() => setView(id)}>
                {label}
              </button>
            ))}
          </nav>
        </div>
        <div className={status.connected ? 'status on' : 'status'} role="status">
          <span className="dot" />
          {status.connected ? `Connected to ${status.simName}` : 'Waiting for Microsoft Flight Simulator'}
        </div>
      </header>

      <RestoreBanner />
      <DescentBanner />
      <UntrackedBanner />
      <UpdateBanner />
      {view === 'home' && (
        <Home
          onJourney={(request) => {
            setJourneyRequest(request)
            setView('journeys')
          }}
          onOpenHangar={() => setView('hangar')}
          onOpenLogbook={() => setView('logbook')}
        />
      )}
      {view === 'journeys' && <Journeys request={journeyRequest} onHandled={() => setJourneyRequest(null)} />}
      {view === 'logbook' && <Logbook />}
      {view === 'hangar' && <Hangar />}
      {view === 'settings' && <Settings />}
    </div>
  )
}
