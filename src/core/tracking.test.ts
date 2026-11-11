import { describe, expect, it } from 'vitest'
import type { LogbookFlight, TelemetrySample } from '../shared/logbook'
import type { RecorderOutput } from './recorder'
import { awayFromHome, FlightGate } from './tracking'

const HOME = { lat: 38.4877, lon: -121.1024, location: { ident: 'KRIU', name: 'Rancho Murieta' } }

describe('awayFromHome', () => {
  it('treats the same airport as home', () => {
    expect(awayFromHome(HOME, 38.49, -121.11)).toBeNull()
  })

  it('names where the aircraft really is when it is elsewhere', () => {
    expect(awayFromHome(HOME, 40.64, -73.78)).toBe("It's at Rancho Murieta (KRIU).")
    expect(awayFromHome({ ...HOME, location: null }, 40.64, -73.78)).toBe("It's still where it last landed.")
  })

  it('tracks an aircraft with no history anywhere', () => {
    expect(awayFromHome(null, 40.64, -73.78)).toBeNull()
  })
})

describe('FlightGate', () => {
  const flight = { id: 'f1' } as LogbookFlight
  const sample = { lat: 40.64, lon: -73.78 } as TelemetrySample
  const started: RecorderOutput = { kind: 'sample', flight, started: true }
  const ongoing: RecorderOutput = { kind: 'sample', flight, started: false }
  const finished: RecorderOutput = { kind: 'finished', flight }

  it('leaves out a flight that started away from home, start to finish', () => {
    const gate = new FlightGate(() => true, () => "It's at KRIU.")
    expect(gate.decide(started, sample)).toEqual({ persist: false, untrackedReason: "It's at KRIU." })
    expect(gate.decide(ongoing, sample)).toEqual({ persist: false })
    expect(gate.isIgnoring('f1')).toBe(true)
    expect(gate.decide(finished, sample)).toEqual({ persist: false })
    expect(gate.isIgnoring('f1')).toBe(false)
  })

  it('logs everything with No teleport off', () => {
    const gate = new FlightGate(() => false, () => "It's at KRIU.")
    expect(gate.decide(started, sample)).toEqual({ persist: true })
    expect(gate.decide(finished, sample)).toEqual({ persist: true })
  })

  it('logs a flight that started at home', () => {
    const gate = new FlightGate(() => true, () => null)
    expect(gate.decide(started, sample)).toEqual({ persist: true })
    expect(gate.decide(ongoing, sample)).toEqual({ persist: true })
  })

  it('decides once, when the flight starts', () => {
    let away: string | null = null
    const gate = new FlightGate(() => true, () => away)
    gate.decide(started, sample)
    away = "It's at KRIU."
    expect(gate.decide(ongoing, sample)).toEqual({ persist: true })
  })
})
