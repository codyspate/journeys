import { useEffect, useState } from 'react'
import type { BackupManifest } from '../../shared/types'
import { errorText } from './errors'

const describe = (manifest: BackupManifest) =>
  `${manifest.flights} ${manifest.flights === 1 ? 'flight' : 'flights'}, ${manifest.journeys} ${manifest.journeys === 1 ? 'Journey' : 'Journeys'} and ${manifest.aircraft} ${manifest.aircraft === 1 ? 'aircraft' : 'aircraft'}`

type Setup = { running: boolean; script: string; node: string; userData: string }

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="copy-block">
      <div className="history-line">
        <span className="muted">{label}</span>
        <button
          className="link"
          onClick={async () => {
            await navigator.clipboard.writeText(text)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  )
}

/** Lets AI apps such as Claude Desktop or Claude Code read flights through the Journeys MCP server. Off until the player turns it on. */
export function AssistantAccess() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [setup, setSetup] = useState<Setup | null>(null)
  const refresh = async () => {
    const settings = await window.journeys.getSettings()
    setEnabled(settings.shareWithAssistants ?? false)
    setSetup((await window.journeys.assistantSetup?.()) ?? null)
  }
  useEffect(() => {
    void refresh()
  }, [])
  if (enabled === null) return null

  // Journeys' own copy of Electron runs the server as plain Node, so no separate Node install is needed.
  const desktopConfig = setup
    ? JSON.stringify({ mcpServers: { journeys: { command: setup.node, args: [setup.script], env: { ELECTRON_RUN_AS_NODE: '1' } } } }, null, 2)
    : ''
  const codeCommand = setup ? `claude mcp add journeys --env ELECTRON_RUN_AS_NODE=1 -- "${setup.node}" "${setup.script}"` : ''

  return (
    <div className="assistant-access">
      <label className="setting">
        <input
          type="checkbox"
          checked={enabled}
          onChange={async (e) => {
            await window.journeys.updateSettings({ shareWithAssistants: e.target.checked })
            await refresh()
          }}
        />
        <span>
          <strong>Let AI assistants read your flights</strong>
          <span className="muted">
            Lets AI apps on this computer, such as Claude Desktop or Claude Code, see where you're flying, your Journeys, logbook, aircraft and
            places, so you can ask things like “what am I flying over?”. They can only read, never change anything, and only while Journeys
            is open. What you ask, and the flight details the AI reads, go to that AI app's provider.
          </span>
        </span>
      </label>
      {enabled && setup && (
        <details className="assistant-setup">
          <summary>Connect an AI app</summary>
          <p className="muted">
            {setup.running ? 'Journeys is ready for AI apps to connect.' : 'Journeys couldn’t start sharing. Try turning this off and on again.'} Add
            Journeys once, then restart the AI app.
          </p>
          <CopyBlock label="Claude Desktop: add this to claude_desktop_config.json (Settings, Developer, Edit Config)" text={desktopConfig} />
          <CopyBlock label="Claude Code: run this once in a terminal" text={codeCommand} />
        </details>
      )}
    </div>
  )
}

/** Back up everything, or bring a backup back. Restoring always asks first and never deletes what's there now. */
export function YourData() {
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [candidate, setCandidate] = useState<{ folder: string; manifest: BackupManifest } | null>(null)
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    void window.journeys.restoredFrom?.().then((setAside) => {
      if (setAside) setMessage(`Restored from your backup. What you had before is kept in ${setAside}.`)
    })
  }, [])

  const attempt = async (action: () => Promise<void>) => {
    setError(null)
    setMessage(null)
    setBusy(true)
    try {
      await action()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="your-data" aria-label="Your data">
      <h3>Your data</h3>
      <p className="muted">
        Everything Journeys keeps lives on this computer. A backup copies your logbook, Journeys, aircraft saves, places, notes and photos
        into one folder you can keep anywhere.
      </p>
      <div className="save-actions">
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            attempt(async () => {
              const result = await window.journeys.writeBackup()
              if (result) setMessage(`Backed up ${describe(result.manifest)} to ${result.folder}.`)
            })
          }
        >
          Back up now
        </button>
        <button
          className="link"
          disabled={busy}
          onClick={() =>
            attempt(async () => {
              setCandidate(await window.journeys.chooseBackup())
            })
          }
        >
          Restore from a backup…
        </button>
      </div>

      {candidate && (
        <div className="reach" role="alertdialog" aria-label="Restore this backup?">
          <p>
            <strong>Restore the backup from {new Date(candidate.manifest.createdAt).toLocaleString()}?</strong> It holds{' '}
            {describe(candidate.manifest)}.
          </p>
          <p className="muted">
            Journeys will restart with the backup in place. Everything you have now is moved to a folder named “before restore”, not deleted.
          </p>
          <div className="save-actions">
            <button
              disabled={restoring}
              onClick={async () => {
                setRestoring(true)
                setError(null)
                try {
                  await window.journeys.restoreBackup(candidate.folder)
                  setMessage('Restarting with your backup…')
                } catch (e) {
                  setError(errorText(e))
                  setRestoring(false)
                }
              }}
            >
              {restoring ? 'Restarting…' : 'Restore and restart'}
            </button>
            <button className="link" disabled={restoring} onClick={() => setCandidate(null)}>
              Keep what I have
            </button>
          </div>
        </div>
      )}

      {message && <p className="note">{message}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
