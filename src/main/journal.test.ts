import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { LogbookFlight, TelemetrySample } from '../shared/logbook'
import { FlightJournalStore } from './journal'
import { Logbook } from './logbook'

const START = Date.UTC(2026, 10, 10, 18, 0)
let root: string
let journal: FlightJournalStore
let screenshots: string

const flight: LogbookFlight = {
  id: 'f1',
  aircraft: null,
  status: 'complete',
  startedAt: START,
  takeoffAt: START + 60_000,
  landedAt: START + 1_200_000,
  endedAt: START + 1_260_000,
  origin: { lat: 38, lon: -121 },
  destination: { lat: 39, lon: -120 },
  startedAirborne: false,
  distanceNm: 60,
  maxAltitudeFt: 5000,
  maxG: 1.2,
  fuelStartGal: 50,
  fuelEndGal: 40,
  landings: [],
  events: []
}

/** An image file that looks like it was saved at a given time. */
function screenshot(name: string, at: number): string {
  const path = join(screenshots, name)
  writeFileSync(path, 'fake image')
  utimesSync(path, new Date(at), new Date(at))
  return path
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'journeys-journal-'))
  screenshots = join(root, 'Captures')
  mkdirSync(screenshots)
  const dbPath = join(root, 'logbook.db')
  const logbook = new Logbook(dbPath)
  logbook.saveFlight(flight)
  // The flight heads north-east, one sample a minute.
  for (let i = 0; i <= 21; i++) logbook.addSample('f1', { t: START + i * 60_000, lat: 38 + i * 0.05, lon: -121 + i * 0.05 } as TelemetrySample)
  logbook.close()
  journal = new FlightJournalStore(dbPath, join(root, 'photos'))
  journal.updatePhotoSettings({ folders: [screenshots], autoAttach: true })
})

describe('flight notes', () => {
  it('saves, trims and clears a note', () => {
    expect(journal.setNote('f1', '  Fog over the delta  ')).toBe('Fog over the delta')
    expect(journal.note('f1')).toBe('Fog over the delta')
    journal.setNote('f1', '   ')
    expect(journal.note('f1')).toBe('')
  })
})

describe('flight photos', () => {
  it('copies a photo in and pins it where the aircraft was when it was taken', () => {
    const [photo] = journal.addPhotos('f1', [screenshot('view.png', START + 10 * 60_000)])
    expect(photo.lat).toBeCloseTo(38.5, 5)
    expect(photo.lon).toBeCloseTo(-120.5, 5)
    expect(photo.url).toBe(`journeys-photo://photo/${photo.id}`)
    expect(existsSync(journal.photoFile(photo.id)!)).toBe(true)
  })

  it('leaves a photo off the map when it was taken long after the flight', () => {
    const [photo] = journal.addPhotos('f1', [screenshot('later.png', START + 6 * 3_600_000)])
    expect(photo.lat).toBeNull()
  })

  it('picks up only screenshots saved during the flight, once', () => {
    screenshot('before.png', START - 3_600_000)
    screenshot('during.png', START + 5 * 60_000)
    screenshot('just-after.jpg', START + 1_300_000)
    screenshot('notes.txt', START + 5 * 60_000)
    expect(journal.attachScreenshotsFrom(flight)).toHaveLength(2)
    expect(journal.attachScreenshotsFrom(flight)).toHaveLength(0)
    expect(journal.journals(['f1']).f1).toEqual({ note: '', photoCount: 2 })
  })

  it('does nothing automatically with the setting off', () => {
    journal.updatePhotoSettings({ autoAttach: false })
    screenshot('during.png', START + 5 * 60_000)
    expect(journal.attachScreenshotsFrom(flight)).toEqual([])
  })

  it('removes a photo, and everything for a flight that left the logbook', () => {
    const [photo] = journal.addPhotos('f1', [screenshot('view.png', START + 60_000)])
    const file = journal.photoFile(photo.id)!
    journal.deletePhoto(photo.id)
    expect(existsSync(file)).toBe(false)
    expect(journal.photos('f1')).toEqual([])

    journal.addPhotos('f1', [screenshot('view2.png', START + 60_000)])
    journal.setNote('f1', 'gone soon')
    journal.forgetFlight('f1')
    expect(journal.journals(['f1']).f1).toEqual({ note: '', photoCount: 0 })
  })
})
