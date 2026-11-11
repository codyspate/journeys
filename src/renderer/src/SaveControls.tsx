import { useState } from 'react'
import { errorText } from './errors'

interface SaveControlsProps {
  name: string
  placeholder?: string
  deleteQuestion: string
  onRename: (name: string) => Promise<void>
  onDelete: () => Promise<void>
}

export function SaveControls({ name, placeholder, deleteQuestion, onRename, onDelete }: SaveControlsProps) {
  const [mode, setMode] = useState<'idle' | 'rename' | 'delete'>('idle')
  const [draft, setDraft] = useState(name)
  const [error, setError] = useState<string | null>(null)

  const attempt = async (action: () => Promise<void>) => {
    setError(null)
    try {
      await action()
      setMode('idle')
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <div className="save-controls">
      {mode === 'idle' && (
        <div className="save-actions">
          <button
            className="link"
            onClick={() => {
              setDraft(name)
              setMode('rename')
            }}
          >
            Rename
          </button>
          <button className="link" onClick={() => setMode('delete')}>
            Delete
          </button>
        </div>
      )}

      {mode === 'rename' && (
        <form
          className="save-actions"
          onSubmit={(e) => {
            e.preventDefault()
            void attempt(() => onRename(draft))
          }}
        >
          <input
            autoFocus
            aria-label="New name"
            placeholder={placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setMode('idle')}
          />
          <button type="submit">Save</button>
          <button type="button" className="link" onClick={() => setMode('idle')}>
            Cancel
          </button>
        </form>
      )}

      {mode === 'delete' && (
        <div className="save-actions">
          <span>{deleteQuestion}</span>
          <button onClick={() => void attempt(onDelete)}>Delete</button>
          <button className="link" onClick={() => setMode('idle')}>
            Keep it
          </button>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
