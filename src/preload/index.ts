import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { JourneysApi, SimStatus } from '../shared/types'

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: JourneysApi = {
  getStatus: () => ipcRenderer.invoke('status:get'),
  liveSim: () => ipcRenderer.invoke('sim:live'),
  onStatus: (listener) => subscribe<SimStatus>('status:changed', listener),
  listFlights: () => ipcRenderer.invoke('logbook:list'),
  flightTrack: (flightId) => ipcRenderer.invoke('logbook:track', flightId),
  atlas: () => ipcRenderer.invoke('logbook:atlas'),
  flightNote: (flightId) => ipcRenderer.invoke('journal:note', flightId),
  setFlightNote: (flightId, text) => ipcRenderer.invoke('journal:setNote', flightId, text),
  flightPhotos: (flightId) => ipcRenderer.invoke('journal:photos', flightId),
  flightJournals: (flightIds) => ipcRenderer.invoke('journal:journals', flightIds),
  addFlightPhotos: (flightId) => ipcRenderer.invoke('journal:addPhotos', flightId),
  deleteFlightPhoto: (id) => ipcRenderer.invoke('journal:deletePhoto', id),
  photoSettings: () => ipcRenderer.invoke('journal:photoSettings'),
  updatePhotoSettings: (changes) => ipcRenderer.invoke('journal:updatePhotoSettings', changes),
  choosePhotoFolder: () => ipcRenderer.invoke('journal:chooseFolder'),
  onPhotosAdded: (listener) => subscribe('journal:photosAdded', listener),
  searchAirports: (query) => ipcRenderer.invoke('airports:search', query),
  listAirports: () => ipcRenderer.invoke('airports:all'),
  listJourneys: () => ipcRenderer.invoke('journeys:list'),
  assistantSetup: () => ipcRenderer.invoke('assistant:setup'),
  writeBackup: () => ipcRenderer.invoke('backup:write'),
  chooseBackup: () => ipcRenderer.invoke('backup:choose'),
  restoreBackup: (folder) => ipcRenderer.invoke('backup:restore', folder),
  restoredFrom: () => ipcRenderer.invoke('backup:restoredFrom'),
  updateState: () => ipcRenderer.invoke('update:get'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateState: (listener) => subscribe('update:changed', listener),
  listPlaces: () => ipcRenderer.invoke('places:list'),
  addPlace: (ident, kind, note) => ipcRenderer.invoke('places:add', ident, kind, note),
  removePlace: (id) => ipcRenderer.invoke('places:remove', id),
  createJourney: (input) => ipcRenderer.invoke('journeys:create', input),
  openJourney: (id) => ipcRenderer.invoke('journeys:open', id),
  updateJourneySettings: (id, settings) => ipcRenderer.invoke('journeys:settings', id, settings),
  hasTerrain: () => ipcRenderer.invoke('terrain:available'),
  editRoute: (id, edit) => ipcRenderer.invoke('journeys:edit', id, edit),
  renameJourney: (id, name) => ipcRenderer.invoke('journeys:rename', id, name),
  deleteJourney: (id) => ipcRenderer.invoke('journeys:delete', id),
  onReach: (listener) => subscribe('journey:reach', listener),
  onJourneyUpdated: (listener) => subscribe('journey:updated', listener),
  onDescentPause: (listener) => subscribe('descent:paused', listener),
  listAirframes: () => ipcRenderer.invoke('airframes:list'),
  renameAirframe: (key, nickname) => ipcRenderer.invoke('airframes:rename', key, nickname),
  deleteAirframe: (key) => ipcRenderer.invoke('airframes:delete', key),
  loadedAirframe: () => ipcRenderer.invoke('airframes:current'),
  airframeFlights: (key) => ipcRenderer.invoke('airframes:flights', key),
  airframeHistory: (key) => ipcRenderer.invoke('airframes:history', key),
  saveAirframe: (key, name) => ipcRenderer.invoke('airframes:save', key, name),
  restoreAirframe: (key, saveId, options) => ipcRenderer.invoke('airframes:restore', key, saveId, options),
  renameAirframeSave: (id, name) => ipcRenderer.invoke('airframes:renameSave', id, name),
  deleteAirframeSave: (id) => ipcRenderer.invoke('airframes:deleteSave', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (changes) => ipcRenderer.invoke('settings:update', changes),
  getOffer: () => ipcRenderer.invoke('offer:get'),
  acceptOffer: () => ipcRenderer.invoke('offer:accept'),
  declineOffer: () => ipcRenderer.invoke('offer:decline'),
  onOffer: (listener) => subscribe('offer:changed', listener),
  onUntracked: (listener) => subscribe('tracking:untracked', listener)
}

contextBridge.exposeInMainWorld('journeys', api)
