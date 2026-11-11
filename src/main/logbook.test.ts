import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LogbookFlight, TelemetrySample } from '../shared/logbook'
import { Logbook } from './logbook'

const directories: string[] = []
function tempPath() {
  const directory = mkdtempSync(join(tmpdir(), 'journeys-test-'))
  directories.push(directory)
  return join(directory, 'nested', 'logbook.db')
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

const flight = (id: string, startedAt: number, status: LogbookFlight['status'] = 'in-progress'): LogbookFlight => ({
  id,
  aircraft: null,
  status,
  startedAt,
  takeoffAt: null,
  landedAt: null,
  endedAt: null,
  origin: { lat: 1, lon: 2 },
  destination: null,
  startedAirborne: false,
  distanceNm: 0,
  maxAltitudeFt: 0,
  maxG: 1,
  fuelStartGal: 50,
  fuelEndGal: 50,
  landings: [],
  events: []
})

const sample = (t: number) => ({ t, lat: 1, lon: 2 }) as TelemetrySample

describe('Logbook', () => {
  it('drops interrupted records where nothing really happened', () => {
    const path = tempPath()
    const first = new Logbook(path)
    first.saveFlight(flight('open', 100))
    first.saveFlight(flight('stopped', 200, 'interrupted'))
    first.saveFlight(flight('jumped', 250, 'ended-early'))
    first.saveFlight({ ...flight('real', 300, 'interrupted'), distanceNm: 40 })
    first.close()

    const second = new Logbook(path)
    expect(second.listFlights().map((f) => f.id)).toEqual(['real'])
    second.close()
  })

  it('lists newest flights first and updates in place', () => {
    const logbook = new Logbook(tempPath())
    logbook.saveFlight(flight('a', 100, 'complete'))
    logbook.saveFlight(flight('b', 200, 'complete'))
    logbook.saveFlight({ ...flight('a', 100, 'complete'), distanceNm: 42 })
    const flights = logbook.listFlights()
    expect(flights.map((f) => f.id)).toEqual(['b', 'a'])
    expect(flights[1].distanceNm).toBe(42)
    logbook.close()
  })

  it('removes samples with a discarded flight', () => {
    const logbook = new Logbook(tempPath())
    logbook.saveFlight(flight('a', 100))
    logbook.addSample('a', sample(100))
    expect(logbook.countSamples('a')).toBe(1)
    logbook.deleteFlight('a')
    expect(logbook.countSamples('a')).toBe(0)
    logbook.close()
  })

  it('keeps a flight open when the app dies and closes it on next start', () => {
    const path = tempPath()
    const first = new Logbook(path)
    first.saveFlight({ ...flight('a', 100), distanceNm: 12 })
    first.addSample('a', sample(150))
    first.close()

    const second = new Logbook(path)
    expect(second.listFlights()[0]).toMatchObject({ status: 'interrupted', endedAt: 150 })
    second.close()
  })

  it('counts a flight left open as complete if it had landed and stopped', () => {
    const path = tempPath()
    const first = new Logbook(path)
    const landing = { t: 200, lat: 3, lon: 4, touchdownFpm: 150, maxG: 1.2, iasKts: 60, gsKts: 60, headwindKts: 0, crosswindKts: 0, bounces: 0 }
    first.saveFlight({ ...flight('a', 100), distanceNm: 60, takeoffAt: 120, landedAt: 200, landings: [landing] })
    first.addSample('a', { ...sample(200), gsKts: 60, onGround: 1 })
    first.addSample('a', { ...sample(900), lat: 3, lon: 4, gsKts: 0, onGround: 1 })
    first.close()

    const second = new Logbook(path)
    expect(second.listFlights()[0]).toMatchObject({ status: 'complete', endedAt: 900, destination: { lat: 3, lon: 4 } })
    second.close()
  })

  it('still counts a landed flight as interrupted if it was rolling when the app closed', () => {
    const path = tempPath()
    const first = new Logbook(path)
    const landing = { t: 200, lat: 3, lon: 4, touchdownFpm: 150, maxG: 1.2, iasKts: 60, gsKts: 60, headwindKts: 0, crosswindKts: 0, bounces: 0 }
    first.saveFlight({ ...flight('a', 100), distanceNm: 60, landings: [landing] })
    first.addSample('a', { ...sample(300), gsKts: 40, onGround: 1 })
    first.close()

    const second = new Logbook(path)
    expect(second.listFlights()[0].status).toBe('interrupted')
    second.close()
  })
})
