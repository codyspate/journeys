import { useEffect, useRef, useState } from 'react'
import type { FlightPhoto, PhotoSettings } from '../../shared/logbook'
import { errorText } from './errors'

/** A full-size photo over the page. Escape, the backdrop or Close dismiss it; arrows step through. */
export function Lightbox({ photos, index, onIndex, onClose }: { photos: FlightPhoto[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null)
  const photo = photos[index]
  useEffect(() => {
    closeButton.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') onIndex(Math.min(photos.length - 1, index + 1))
      if (e.key === 'ArrowLeft') onIndex(Math.max(0, index - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, photos.length, onClose, onIndex])
  if (!photo) return null
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Photo" onClick={onClose}>
      <img src={photo.url} alt={`Taken ${new Date(photo.takenAt).toLocaleString()}`} onClick={(e) => e.stopPropagation()} />
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span>
          {new Date(photo.takenAt).toLocaleString()} · {index + 1} of {photos.length}
        </span>
        <button className="link" disabled={index === 0} onClick={() => onIndex(index - 1)}>
          Previous
        </button>
        <button className="link" disabled={index === photos.length - 1} onClick={() => onIndex(index + 1)}>
          Next
        </button>
        <button ref={closeButton} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}

/** The player's note for a flight, saved when they click away. */
function NoteEditor({ flightId }: { flightId: string }) {
  const [text, setText] = useState('')
  const [saved, setSaved] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    void window.journeys.flightNote(flightId).then((note) => {
      if (!current) return
      setText(note)
      setSaved(note)
    })
    return () => {
      current = false
    }
  }, [flightId])

  const save = async () => {
    if (text.trim() === saved) return
    try {
      const note = await window.journeys.setFlightNote(flightId, text)
      setSaved(note)
      setStatus('Saved')
    } catch (e) {
      setStatus(errorText(e))
    }
  }

  return (
    <label className="field note-field">
      <span>
        Notes {status && <span className="muted">· {status}</span>}
      </span>
      <textarea
        rows={3}
        placeholder="What happened on this flight? Weather, the view, a landing to remember…"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setStatus(null)
        }}
        onBlur={() => void save()}
      />
    </label>
  )
}

/** Notes and screenshots for one flight. */
export function FlightJournalPanel({
  flightId,
  photos,
  onPhotosChanged,
  onOpenPhoto
}: {
  flightId: string
  photos: FlightPhoto[]
  onPhotosChanged: () => void
  onOpenPhoto: (index: number) => void
}) {
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flight-journal">
      <NoteEditor key={flightId} flightId={flightId} />
      <div className="photo-strip">
        {photos.map((photo, i) => (
          <figure key={photo.id}>
            <button className="photo-thumb" onClick={() => onOpenPhoto(i)} aria-label={`Open photo taken ${new Date(photo.takenAt).toLocaleTimeString()}`}>
              <img src={photo.url} alt="" loading="lazy" />
            </button>
            <figcaption>
              {new Date(photo.takenAt).toLocaleTimeString()}
              <button
                className="link"
                aria-label="Remove this photo"
                onClick={async () => {
                  await window.journeys.deleteFlightPhoto(photo.id)
                  onPhotosChanged()
                }}
              >
                Remove
              </button>
            </figcaption>
          </figure>
        ))}
        <button
          className="secondary add-photos"
          onClick={async () => {
            setError(null)
            try {
              await window.journeys.addFlightPhotos(flightId)
              onPhotosChanged()
            } catch (e) {
              setError(errorText(e))
            }
          }}
        >
          Add photos
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** Where screenshots are picked up from after each flight. */
export function PhotoSettingsPanel() {
  const [settings, setSettings] = useState<PhotoSettings | null>(null)
  useEffect(() => {
    void window.journeys.photoSettings?.().then(setSettings)
  }, [])
  if (!settings) return null
  const update = async (changes: Partial<PhotoSettings>) => setSettings(await window.journeys.updatePhotoSettings(changes))

  return (
    <div className="photo-settings">
      <label className="checkbox">
        <input type="checkbox" checked={settings.autoAttach} onChange={(e) => void update({ autoAttach: e.target.checked })} />
        Add screenshots taken during a flight to it automatically
      </label>
      <p className="muted">
        When a flight ends, any image saved in these folders while it was in progress is copied into Journeys and pinned on the flight's map
        where you took it.
      </p>
      <ul className="home-list">
        {settings.folders.map((folder) => (
          <li key={folder}>
            <span>{folder}</span>
            <button className="link" onClick={() => void update({ folders: settings.folders.filter((f) => f !== folder) })}>
              Remove
            </button>
          </li>
        ))}
        {settings.folders.length === 0 && <li className="muted">No folders yet.</li>}
      </ul>
      <button
        className="secondary"
        onClick={async () => {
          const folder = await window.journeys.choosePhotoFolder()
          if (folder && !settings.folders.includes(folder)) await update({ folders: [...settings.folders, folder] })
        }}
      >
        Add a folder
      </button>
    </div>
  )
}
