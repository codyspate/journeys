import { useEffect, useState } from 'react'
import type { UntrackedFlight } from '../../shared/airframe'

/** Says plainly when a flight is being left out of the logbook because of No teleport, and how to change that. */
export function UntrackedBanner() {
  const [untracked, setUntracked] = useState<UntrackedFlight | null>(null)
  // Optional so a window reloaded during development against an older background process still works.
  useEffect(() => window.journeys.onUntracked?.(setUntracked), [])
  if (!untracked) return null
  return (
    <div className="banner" role="status">
      <p>
        <strong>This flight isn't being logged.</strong> No teleport is on, and {untracked.aircraft} didn't take off from where it last
        landed. {untracked.reason} Restore it there from the Hangar to keep its story going, or turn off No teleport in the Hangar.
      </p>
      <button className="link" onClick={() => setUntracked(null)}>
        Dismiss
      </button>
    </div>
  )
}
