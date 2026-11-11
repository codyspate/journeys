import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron'
import { AirframeTracker } from '../core/airframes'
import { DescentWatcher } from '../core/descent'
import { FlightRecorder, hasPosition } from '../core/recorder'
import { DEFAULT_TIMING } from '../core/restore'
import { awayFromHome, FlightGate, type Home } from '../core/tracking'
import { type LiveSim, type RestoreOffer, type Settings, splitAirframeKey, type UntrackedFlight } from '../shared/airframe'
import type { CreateJourneyInput, JourneySettings, PlaceKind, RouteEdit } from '../shared/journey'
import {
  type AircraftFlight,
  type Atlas,
  isUnfinished,
  type LogbookFlight,
  type PhotoSettings,
  SIM_PAUSED_ITSELF,
  type TelemetrySample
} from '../shared/logbook'
import type { RestoreOptions, SimStatus } from '../shared/types'
import { AirframeDatabase } from './airframes'
import { AssistantEndpoint } from './assistant'
import { applyPendingRestore, backupBeforeNewVersion, readBackup, stageRestore, writeBackup } from './backup'
import { FlightJournalStore } from './journal'
import { PlaceStore } from './places'
import { JourneyService } from './journeys'
import { Logbook } from './logbook'
import { SimConnection } from './simconnect'
import { SnapshotStore } from './snapshots'
import { Updates } from './updates'

// Photos are served to the window from the app's own folder through this scheme.
protocol.registerSchemesAsPrivileged([{ scheme: 'journeys-photo', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

const sim = new SimConnection()
/** Screenshot files can take a moment to finish writing after a flight ends. */
const ATTACH_PHOTOS_AFTER_MS = 5000
const IMAGE_FILTER = [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
/** Fewer points per flight than the single-flight map, since many are drawn at once. */
const POINTS_PER_AIRCRAFT_FLIGHT = 1500
const POINTS_PER_ATLAS_FLIGHT = 600
const ATLAS_FLIGHTS = 1000
const AT_AIRPORT_NM = 3

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 780,
    title: 'Journeys',
    backgroundColor: '#0e1420',
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js') }
  })
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void window.loadURL(devUrl)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
  return window
}

void app.whenReady().then(() => {
  ipcMain.handle('status:get', () => sim.status)

  // A restore chosen last time is swapped in before anything opens the database.
  const userData = app.getPath('userData')
  let restoredFrom: string | null = null
  try {
    restoredFrom = applyPendingRestore(userData)
  } catch (error) {
    console.error('Could not restore the backup:', error)
  }
  // A new version's first start: keep a copy of everything before it changes anything.
  try {
    const saved = backupBeforeNewVersion(userData, app.getVersion())
    if (saved) console.log('Backed up before this new version:', saved)
  } catch (error) {
    console.error('Could not back up before the new version:', error)
  }

  const window = createWindow()
  const logbook = new Logbook(join(app.getPath('userData'), 'logbook.db'))
  const recorder = new FlightRecorder(randomUUID)
  ipcMain.handle('logbook:list', () => logbook.listFlights())
  ipcMain.handle('logbook:track', (_event, flightId: string) => logbook.track(flightId))

  const journal = new FlightJournalStore(join(app.getPath('userData'), 'logbook.db'), join(app.getPath('userData'), 'photos'))
  protocol.handle('journeys-photo', (request) => {
    const file = journal.photoFile(new URL(request.url).pathname.replace(/^\//, ''))
    return file ? net.fetch(pathToFileURL(file).toString()) : new Response('Not found', { status: 404 })
  })
  ipcMain.handle('journal:note', (_event, flightId: string) => journal.note(flightId))
  ipcMain.handle('journal:setNote', (_event, flightId: string, text: string) => journal.setNote(flightId, text))
  ipcMain.handle('journal:photos', (_event, flightId: string) => journal.photos(flightId))
  ipcMain.handle('journal:journals', (_event, flightIds: string[]) => journal.journals(flightIds))
  ipcMain.handle('journal:addPhotos', async (_event, flightId: string) => {
    const picked = await dialog.showOpenDialog(window, { title: 'Add photos to this flight', properties: ['openFile', 'multiSelections'], filters: IMAGE_FILTER })
    return picked.canceled ? [] : journal.addPhotos(flightId, picked.filePaths)
  })
  ipcMain.handle('journal:deletePhoto', (_event, id: string) => journal.deletePhoto(id))
  ipcMain.handle('journal:photoSettings', () => journal.photoSettings)
  ipcMain.handle('journal:updatePhotoSettings', (_event, changes: Partial<PhotoSettings>) => journal.updatePhotoSettings(changes))
  ipcMain.handle('journal:chooseFolder', async () => {
    const picked = await dialog.showOpenDialog(window, { title: 'Choose a screenshot folder', properties: ['openDirectory'] })
    return picked.canceled ? null : picked.filePaths[0]
  })
  /** After a logged flight ends, picks up the screenshots taken during it. */
  const attachScreenshots = (flight: LogbookFlight) =>
    setTimeout(() => {
      try {
        const added = journal.attachScreenshotsFrom(flight)
        if (added.length > 0 && !window.isDestroyed()) window.webContents.send('journal:photosAdded', flight.id)
      } catch (error) {
        console.error('Could not attach screenshots:', error)
      }
    }, ATTACH_PHOTOS_AFTER_MS)

  const journeys = new JourneyService(
    join(app.getPath('userData'), 'logbook.db'),
    join(app.getAppPath(), 'resources/airports.json'),
    join(app.getAppPath(), 'resources/terrain.bin.gz')
  )
  ipcMain.handle('airports:search', (_event, query: string) => journeys.airports.search(query))
  ipcMain.handle('airports:all', () => journeys.airports.all)
  ipcMain.handle('journeys:list', () => journeys.list())
  ipcMain.handle('journeys:create', (_event, input: CreateJourneyInput) => journeys.create(input))
  ipcMain.handle('journeys:open', (_event, id: string) => journeys.open(id))
  ipcMain.handle('journeys:settings', (_event, id: string, settings: JourneySettings) => journeys.updateSettings(id, settings))
  ipcMain.handle('terrain:available', () => journeys.terrain !== undefined)
  ipcMain.handle('journeys:edit', (_event, id: string, edit: RouteEdit) => journeys.edit(id, edit))
  ipcMain.handle('journeys:rename', (_event, id: string, name: string) => journeys.rename(id, name))
  ipcMain.handle('journeys:delete', (_event, id: string) => journeys.delete(id))

  const places = new PlaceStore(join(app.getPath('userData'), 'logbook.db'), journeys.airports)
  ipcMain.handle('places:list', () => places.list())
  ipcMain.handle('places:add', (_event, ident: string, kind: PlaceKind, note: string) => places.add(ident, kind, note))
  ipcMain.handle('places:remove', (_event, id: string) => places.remove(id))

  const airframes = new AirframeDatabase(join(app.getPath('userData'), 'logbook.db'), journeys.airports)

  /** Where an aircraft really is: its parked save or where its last logged flight landed, whichever is newer. */
  const homeOf = (key: string): Home | null => {
    const candidates: (Home & { at: number })[] = []
    const record = airframes.get(key)
    const lat = record?.snapshot.values['position.latitude']
    const lon = record?.snapshot.values['position.longitude']
    if (record && lat != null && lon != null) candidates.push({ lat, lon, location: record.location, at: Date.parse(record.snapshot.capturedAt) })
    const [title, livery] = splitAirframeKey(key)
    const landed = logbook.flightsFor(title, livery, 20).find((flight) => flight.landings.length > 0 && flight.destination)
    if (landed?.destination) {
      const airport = journeys.airports.nearest(landed.destination.lat, landed.destination.lon, AT_AIRPORT_NM)
      candidates.push({
        ...landed.destination,
        location: airport ? { ident: airport.ident, name: airport.name } : null,
        at: landed.endedAt ?? landed.landedAt ?? landed.startedAt
      })
    }
    return candidates.sort((a, b) => b.at - a.at)[0] ?? null
  }
  const awayReason = (key: string, lat: number, lon: number) =>
    airframes.settings.noTeleport ? awayFromHome(homeOf(key), lat, lon) : null

  let offer: RestoreOffer | null = null
  const tracker = new AirframeTracker(
    sim,
    airframes,
    () => airframes.settings,
    (next) => {
      offer = next
      if (window.isDestroyed()) return
      window.webContents.send('offer:changed', next)
      if (next) window.flashFrame(true)
    },
    DEFAULT_TIMING,
    awayReason
  )
  const gate = new FlightGate(
    () => airframes.settings.noTeleport,
    (sample) => {
      const key = tracker.currentKey
      return key ? awayReason(key, sample.lat, sample.lon) : null
    }
  )
  ipcMain.handle('airframes:list', () => airframes.list())
  ipcMain.handle('airframes:rename', (_event, key: string, nickname: string) => airframes.rename(key, nickname))
  ipcMain.handle('airframes:delete', (_event, key: string) => {
    airframes.delete(key)
    tracker.forget(key)
  })
  const airportAt = (point: { lat: number; lon: number } | null) =>
    point ? journeys.airports.nearest(point.lat, point.lon, AT_AIRPORT_NM) : null
  const withPath = (flight: LogbookFlight, points: number): AircraftFlight => ({
    flight,
    fromIdent: flight.startedAirborne ? null : (airportAt(flight.origin)?.ident ?? null),
    toIdent: flight.landings.length > 0 ? (airportAt(flight.destination)?.ident ?? null) : null,
    track: logbook.track(flight.id, points)
  })
  /** Maps leave out flights that didn't finish, unless the player asked to see them. */
  const onMaps = (flight: LogbookFlight) => airframes.settings.showUnfinishedFlights || !isUnfinished(flight)
  ipcMain.handle('airframes:flights', (_event, key: string): AircraftFlight[] => {
    const [title, livery] = splitAirframeKey(key)
    return logbook.flightsFor(title, livery).filter(onMaps).map((flight) => withPath(flight, POINTS_PER_AIRCRAFT_FLIGHT))
  })
  ipcMain.handle('logbook:atlas', (): Atlas => {
    const flights = logbook.listFlights(ATLAS_FLIGHTS).filter(onMaps).map((flight) => withPath(flight, POINTS_PER_ATLAS_FLIGHT))
    // Every airport landed at or departed from, and the countries they're in.
    const visited = new Map<string, { ident: string; name: string; country: string }>()
    for (const { flight } of flights) {
      const ends = [flight.startedAirborne ? null : flight.origin, ...flight.landings.map((l) => ({ lat: l.lat, lon: l.lon }))]
      for (const end of ends) {
        const airport = airportAt(end)
        if (airport) visited.set(airport.ident, { ident: airport.ident, name: airport.name, country: airport.country })
      }
    }
    return { flights, airports: [...visited.values()], countries: [...new Set([...visited.values()].map((a) => a.country))].sort() }
  })
  ipcMain.handle('airframes:current',() => (sim.status.connected ? tracker.currentKey : null))
  ipcMain.handle('airframes:history', (_event, key: string) => airframes.history(key))
  ipcMain.handle('airframes:save', async (_event, key: string, name: string) =>
    airframes.saveManual(key, await tracker.captureNow(key), name)
  )
  ipcMain.handle('airframes:restore', (_event, key: string, saveId: string | null, options: RestoreOptions | null) => {
    const snapshot = saveId ? airframes.getSave(saveId).snapshot : airframes.get(key)?.snapshot
    if (!snapshot) throw new Error('That aircraft has no saved state yet.')
    return tracker.restoreNow(key, snapshot, options ?? undefined)
  })
  ipcMain.handle('airframes:renameSave', (_event, id: string, name: string) => airframes.renameSave(id, name))
  ipcMain.handle('airframes:deleteSave', (_event, id: string) => airframes.deleteSave(id))

  ipcMain.handle('backup:write', async () => {
    const picked = await dialog.showOpenDialog(window, { title: 'Choose where to save the backup', properties: ['openDirectory', 'createDirectory'] })
    if (picked.canceled) return null
    return writeBackup(userData, picked.filePaths[0])
  })
  ipcMain.handle('backup:choose', async () => {
    const picked = await dialog.showOpenDialog(window, { title: 'Choose a Journeys backup folder', properties: ['openDirectory'] })
    if (picked.canceled) return null
    return { folder: picked.filePaths[0], manifest: readBackup(picked.filePaths[0]) }
  })
  ipcMain.handle('backup:restore', (_event, folder: string) => {
    if (logbook.listFlights(10).some((flight) => flight.status === 'in-progress')) {
      throw new Error('A flight is being recorded right now. Finish it, then restore.')
    }
    stageRestore(userData, folder)
    // Give the window time to show what's happening, then start again with the backup in place.
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 1500)
  })
  ipcMain.handle('backup:restoredFrom', () => restoredFrom)

  const updates = new Updates(
    () => logbook.listFlights(10).some((flight) => flight.status === 'in-progress'),
    (state) => !window.isDestroyed() && window.webContents.send('update:changed', state)
  )
  ipcMain.handle('update:get', () => updates.current)
  ipcMain.handle('update:check', () => updates.check())
  ipcMain.handle('update:install', () => updates.install())
  updates.start()

  // The Restore lab is gone; its saves live on in each aircraft's history.
  void new SnapshotStore(join(app.getPath('userData'), 'snapshots'))
    .list()
    .then((snapshots) => airframes.importLabSaves(snapshots))
    .catch((error) => console.error('Could not import Restore lab saves:', error))
  ipcMain.handle('settings:get', () => airframes.settings)
  ipcMain.handle('settings:update', async (_event, changes: Partial<Settings>) => {
    const settings = airframes.updateSettings(changes)
    if ('shareWithAssistants' in changes) await syncAssistantEndpoint()
    return settings
  })

  // Read-only access for AI assistants through the Journeys MCP server, only while the player allows it.
  const assistant = new AssistantEndpoint(userData, {
    connected: () => sim.status.connected,
    lastSample: () => lastSample,
    aircraftName: () => {
      const key = tracker.currentKey
      return key ? (airframes.get(key)?.nickname ?? splitAirframeKey(key)[0]) : null
    },
    airports: journeys.airports,
    journeys: () => journeys.list(),
    flights: (limit) => logbook.listFlights(limit),
    journals: (ids) => journal.journals(ids),
    airframes: () => airframes.list(),
    places: () => places.list()
  })
  const syncAssistantEndpoint = async () => {
    try {
      if (airframes.settings.shareWithAssistants) await assistant.start()
      else assistant.stop()
    } catch (error) {
      console.error('Could not start the assistant endpoint:', error)
    }
  }
  void syncAssistantEndpoint()
  app.on('will-quit', () => assistant.stop())
  ipcMain.handle('assistant:setup', () => ({
    running: assistant.running,
    // Installed: the bundled server shipped beside the app. In development: the source file.
    script: app.isPackaged ? join(process.resourcesPath, 'mcp', 'journeys-mcp.mjs') : join(app.getAppPath(), 'mcp', 'journeys-mcp.mjs'),
    node: process.execPath,
    userData
  }))
  ipcMain.handle('offer:get', () => offer)
  ipcMain.handle('offer:accept', () => tracker.accept())
  ipcMain.handle('offer:decline', () => tracker.decline())

  let lastSample: TelemetrySample | null = null
  ipcMain.handle('sim:live', (): LiveSim => {
    const key = sim.status.connected ? tracker.currentKey : null
    const sample = sim.status.connected && lastSample && hasPosition(lastSample) ? lastSample : null
    const airport = sample ? journeys.airports.nearest(sample.lat, sample.lon, AT_AIRPORT_NM) : null
    return {
      connected: sim.status.connected,
      aircraftKey: key,
      aircraftName: key ? (airframes.get(key)?.nickname ?? splitAirframeKey(key)[0]) : null,
      lat: sample?.lat ?? null,
      lon: sample?.lon ?? null,
      onGround: sample ? Boolean(sample.onGround) : null,
      nearAirport: airport ? { ident: airport.ident, name: airport.name } : null,
      headingTrue: sample?.headingTrue ?? null,
      altFt: sample?.altFt ?? null,
      gsKts: sample?.gsKts ?? null,
      paused: Boolean(sample?.pauseFlags),
      flightId: logbook.listFlights(3).find((flight) => flight.status === 'in-progress')?.id ?? null
    }
  })

  const descent = new DescentWatcher()
  sim.on('telemetry', (sample: TelemetrySample) => {
    lastSample = sample
    tracker.ingest(sample)
    const next = sample.onGround ? null : journeys.descentTarget()
    const tod = descent.ingest(sample, next?.target ?? null, next?.settings ?? null)
    if (tod) {
      try {
        sim.fireEvent('PAUSE_ON')
      } catch (error) {
        console.error('Could not pause the sim:', error)
      }
      if (!window.isDestroyed()) {
        window.webContents.send('descent:paused', tod)
        window.flashFrame(true)
      }
    }
    const reach = journeys.reach(sample)
    if (reach && !window.isDestroyed()) window.webContents.send('journey:reach', reach)

    const output = recorder.ingest(sample)
    const decision = gate.decide(output, sample)
    if (!decision.persist) {
      // No teleport is on and this aircraft took off somewhere it isn't: the flight is left out entirely.
      if (decision.untrackedReason && !window.isDestroyed()) {
        const key = tracker.currentKey
        const aircraft = key ? (airframes.get(key)?.nickname ?? splitAirframeKey(key)[0]) : 'This aircraft'
        const untracked: UntrackedFlight = { aircraft, reason: decision.untrackedReason }
        window.webContents.send('tracking:untracked', untracked)
      }
      return
    }
    if (output.kind === 'sample' && output.started && !window.isDestroyed()) window.webContents.send('tracking:untracked', null)
    if (output.kind === 'sample') {
      logbook.saveFlight(output.flight)
      // While the sim has paused itself it repeats frozen values; keeping them would only pad the flight's times.
      if (!((sample.pauseFlags ?? 0) & SIM_PAUSED_ITSELF)) logbook.addSample(output.flight.id, sample)
      if (output.started) {
        void sim
          .readAircraft()
          .then((aircraft) => {
            output.flight.aircraft = aircraft
            logbook.saveFlight(output.flight)
          })
          .catch(() => {})
      }
    } else if (output.kind === 'finished') {
      if (output.flight.status === 'complete') logbook.saveFlight(output.flight)
      else logbook.saveInterrupted(output.flight)
      attachScreenshots(output.flight)
      const updated = journeys.recordFlight(output.flight)
      if (updated && !window.isDestroyed()) window.webContents.send('journey:updated', updated)
    } else if (output.kind === 'discarded') {
      logbook.deleteFlight(output.flightId)
      journal.forgetFlight(output.flightId)
    }
  })

  sim.on('status', (status: SimStatus) => {
    if (!status.connected) {
      tracker.reset()
      const interrupted = recorder.interrupt()
      if (interrupted && !gate.isIgnoring(interrupted.id)) logbook.saveInterrupted(interrupted)
    }
    if (!window.isDestroyed()) window.webContents.send('status:changed', status)
  })
  // Test runs set this so a second copy of the app never reads from, or pauses, a sim someone is flying.
  if (!process.env.JOURNEYS_NO_SIM) sim.start()
})

app.on('window-all-closed', () => {
  sim.stop()
  app.quit()
})
