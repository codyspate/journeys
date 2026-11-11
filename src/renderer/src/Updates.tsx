import { useEffect, useState } from 'react'
import type { UpdateState } from '../../shared/types'
import { errorText } from './errors'

function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null)
  useEffect(() => {
    // Optional so a window reloaded during development against an older background process still works.
    void window.journeys.updateState?.().then(setState)
    return window.journeys.onUpdateState?.(setState)
  }, [])
  return state
}

/** Appears once an update has downloaded. Installing waits for the player, and never interrupts a flight. */
export function UpdateBanner() {
  const state = useUpdateState()
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (state?.kind !== 'ready' || dismissed === state.version) return null
  return (
    <div className="banner" role="status">
      <p>
        <strong>Journeys {state.version} is ready.</strong> Restart to update now, or it installs the next time you close Journeys.
        {error && <span className="error"> {error}</span>}
      </p>
      <div className="banner-actions">
        <button
          onClick={async () => {
            setError(null)
            try {
              await window.journeys.installUpdate()
            } catch (e) {
              setError(errorText(e))
            }
          }}
        >
          Restart to update
        </button>
        <button className="link" onClick={() => setDismissed(state.version)}>
          Later
        </button>
      </div>
    </div>
  )
}

const describe = (state: UpdateState): string => {
  switch (state.kind) {
    case 'development':
      return 'This is a development copy, so it doesn’t update itself.'
    case 'checking':
      return 'Checking for updates…'
    case 'up-to-date':
      return 'You have the latest version.'
    case 'downloading':
      return `Downloading version ${state.version}…`
    case 'ready':
      return `Version ${state.version} is ready. Restart to update, or it installs when you close Journeys.`
    case 'error':
      return state.message
    default:
      return 'Journeys checks for updates when it starts, and every few hours.'
  }
}

/** The running version and update status, for Settings. */
export function VersionSettings() {
  const state = useUpdateState()
  const [checking, setChecking] = useState(false)
  if (!state) return null
  return (
    <div className="version-settings">
      <p>
        <strong>Journeys {state.current}</strong> <span className="muted">· {describe(state)}</span>
      </p>
      {state.kind !== 'development' && state.kind !== 'ready' && (
        <button
          className="secondary"
          disabled={checking || state.kind === 'checking' || state.kind === 'downloading'}
          onClick={async () => {
            setChecking(true)
            try {
              await window.journeys.checkForUpdates()
            } finally {
              setChecking(false)
            }
          }}
        >
          Check for updates
        </button>
      )}
    </div>
  )
}
