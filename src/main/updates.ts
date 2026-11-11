import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/types'

/** Updates are looked for at start and then every few hours while Journeys stays open. */
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

/**
 * Keeps the installed app up to date from GitHub Releases. Updates download quietly; installing waits
 * for the player, and never happens while a flight is being recorded. Closing Journeys installs a
 * downloaded update too.
 */
export class Updates {
  private state: UpdateState = { kind: 'idle', current: app.getVersion() }

  constructor(
    private readonly flightInProgress: () => boolean,
    private readonly onChange: (state: UpdateState) => void
  ) {}

  get current(): UpdateState {
    return this.state
  }

  start(): void {
    // A development copy has nothing to update from.
    if (!app.isPackaged) {
      this.set({ kind: 'development', current: app.getVersion() })
      return
    }
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => this.set({ kind: 'checking', current: app.getVersion() }))
    autoUpdater.on('update-not-available', () => this.set({ kind: 'up-to-date', current: app.getVersion() }))
    autoUpdater.on('update-available', (info) => this.set({ kind: 'downloading', current: app.getVersion(), version: info.version }))
    autoUpdater.on('update-downloaded', (info) =>
      this.set({
        kind: 'ready',
        current: app.getVersion(),
        version: info.version,
        notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null
      })
    )
    autoUpdater.on('error', (error) => {
      console.error('Update check failed:', error)
      this.set({ kind: 'error', current: app.getVersion(), message: 'Couldn’t check for updates. Journeys will try again later.' })
    })
    void this.check()
    setInterval(() => void this.check(), CHECK_EVERY_MS).unref()
  }

  async check(): Promise<UpdateState> {
    if (!app.isPackaged) return this.state
    // A downloaded update stays ready; checking again would only download it twice.
    if (this.state.kind === 'ready' || this.state.kind === 'downloading') return this.state
    try {
      await autoUpdater.checkForUpdates()
    } catch {
      // Reported through the 'error' event.
    }
    return this.state
  }

  install(): void {
    if (this.state.kind !== 'ready') throw new Error('There’s no update ready to install.')
    if (this.flightInProgress()) {
      throw new Error('A flight is being recorded. Land and park first, or just close Journeys afterwards and the update installs then.')
    }
    // Quietly install and open the new version.
    autoUpdater.quitAndInstall(true, true)
  }

  private set(state: UpdateState): void {
    this.state = state
    this.onChange(state)
  }
}
