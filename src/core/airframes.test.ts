import { beforeEach, describe, expect, it } from 'vitest'
import { type AirframeRecord, airframeKey, type RestoreOffer, type Settings } from '../shared/airframe'
import { BASE_CATALOG } from '../shared/catalog'
import type { TelemetrySample } from '../shared/logbook'
import type { AircraftInfo, Snapshot, StateValues, StateVar } from '../shared/types'
import { AirframeTracker, type AirframeStore } from './airframes'
import type { NumberRead, RestoreTiming, SavedPosition, SimPort } from './restore'

const noWait: RestoreTiming = { wait: async () => {}, positionSettleMs: 0, stepDelayMs: 0, finalSettleMs: 0 }
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

const AIRCRAFT: AircraftInfo = { title: 'Comanche', livery: 'Red', atcId: 'N1' }
const KEY = airframeKey(AIRCRAFT.title, AIRCRAFT.livery)

class FakePort implements SimPort {
  aircraft = AIRCRAFT
  values: StateValues = {
    engineCount: 1,
    onGround: 1,
    groundSpeed: 0,
    'position.latitude': 38,
    'position.longitude': -121,
    'position.altitude': 100,
    'position.heading': 90,
    'fuel.leftMain': 20,
    'electrical.battery1': 0
  }
  moved = 0
  async readNumbers(vars: NumberRead[]) {
    return Object.fromEntries(vars.map((v) => [v.id, this.values[v.id] ?? null]))
  }
  async readAircraft() {
    return this.aircraft
  }
  setNumber(variable: StateVar, value: number) {
    this.values[variable.id] = value
  }
  fireEvent(event: string, value?: number) {
    const target = BASE_CATALOG.find((v) => 'event' in v.restore && v.restore.event === event && (v.restore.kind !== 'toggle' || v.restore.value === value))!
    this.values[target.id] = target.restore.kind === 'toggle' ? (this.values[target.id] ? 0 : 1) : value!
  }
  setPosition(position: SavedPosition, _method: string) {
    this.moved++
    this.values['position.latitude'] = position.latitude
    this.values['position.longitude'] = position.longitude
    this.values['position.altitude'] = position.altitude
    this.values['position.heading'] = position.heading
  }
  drainErrors() {
    return []
  }
}

class MemoryStore implements AirframeStore {
  records = new Map<string, AirframeRecord>()
  saves = 0
  get(key: string) {
    return this.records.get(key) ?? null
  }
  save(key: string, snapshot: Snapshot) {
    this.saves++
    this.records.set(key, { key, snapshot, location: null })
  }
}

let port: FakePort
let store: MemoryStore
let offers: (RestoreOffer | null)[]
let settings: Settings
let tracker: AirframeTracker
let t: number

beforeEach(() => {
  port = new FakePort()
  store = new MemoryStore()
  offers = []
  settings = { saveAircraftLocation: true, noTeleport: false, shareWithAssistants: false, showUnfinishedFlights: false }
  tracker = new AirframeTracker(port, store, () => settings, (offer) => offers.push(offer), noWait)
  t = 1_000_000
})

const lastOffer = () => offers.at(-1) ?? null

function sample(overrides: Partial<TelemetrySample> = {}): TelemetrySample {
  return { t, lat: 38, lon: -121, onGround: 1, gsKts: 0, parkingBrake: 1, engine1: 0, engine2: 0, engine3: 0, engine4: 0, ...overrides } as TelemetrySample
}

async function run(seconds: number, overrides: Partial<TelemetrySample> = {}) {
  for (let i = 0; i < seconds; i++) {
    t += 1000
    tracker.ingest(sample(overrides))
    await flush()
  }
}

function saved(values: StateValues): AirframeRecord {
  const snapshot: Snapshot = {
    id: KEY,
    name: 'Comanche',
    capturedAt: '2026-11-01T00:00:00.000Z',
    aircraft: AIRCRAFT,
    profileId: 'default',
    engineCount: 1,
    parked: true,
    values: { ...port.values, ...values }
  }
  return { key: KEY, snapshot, location: { ident: 'PANC', name: 'Anchorage' } }
}

const elsewhere = { 'position.latitude': 61, 'position.longitude': -150, 'electrical.battery1': 1 }

describe('remembering aircraft', () => {
  it('saves a new aircraft once it has been parked briefly', async () => {
    await run(3)
    expect(store.saves).toBe(0)
    await run(6)
    expect(store.saves).toBe(1)
    expect(store.get(KEY)?.snapshot.parked).toBe(true)
  })

  it('keeps saving while parked, but not constantly', async () => {
    await run(40)
    expect(store.saves).toBe(3)
  })

  it('does not save while moving', async () => {
    await run(30, { gsKts: 12 })
    expect(store.saves).toBe(0)
  })

  it('does not save while stopped with the engine running and no brake', async () => {
    await run(30, { engine1: 1, parkingBrake: 0 })
    expect(store.saves).toBe(0)
  })

  it('saves nothing with the setting off', async () => {
    settings.saveAircraftLocation = false
    await run(30)
    expect(store.saves).toBe(0)
  })
})

describe('deleting a save', () => {
  it('does not save the parked aircraft again until it moves', async () => {
    await run(10)
    expect(store.saves).toBe(1)
    store.records.delete(KEY)
    tracker.forget(KEY)
    await run(40)
    expect(store.get(KEY)).toBeNull()
    await run(2, { gsKts: 10 })
    await run(10)
    expect(store.get(KEY)).not.toBeNull()
  })

  it('withdraws the offer for that aircraft', async () => {
    store.records.set(KEY, saved(elsewhere))
    await run(2)
    expect(lastOffer()).not.toBeNull()
    store.records.delete(KEY)
    tracker.forget(KEY)
    expect(lastOffer()).toBeNull()
    await run(40)
    expect(store.get(KEY)).toBeNull()
  })

  it('leaves other aircraft alone', async () => {
    await run(10)
    tracker.forget('Something else|Blue')
    await run(16)
    expect(store.saves).toBe(2)
  })

  it('offers an aircraft by the name the player gave it', async () => {
    store.records.set(KEY, { ...saved(elsewhere), nickname: 'Old Reliable' })
    await run(2)
    expect(lastOffer()?.title).toBe('Old Reliable')
  })
})

describe('coming back to an aircraft', () => {
  it('offers the saved state and protects it until you decide', async () => {
    store.records.set(KEY, saved(elsewhere))
    await run(40)
    expect(lastOffer()).toMatchObject({ key: KEY, location: { ident: 'PANC' } })
    expect(store.saves).toBe(0)
  })

  it('restores on accept and resumes saving', async () => {
    store.records.set(KEY, saved(elsewhere))
    await run(2)
    const report = await tracker.accept()
    expect(port.moved).toBe(1)
    expect(port.values['position.latitude']).toBe(61)
    expect(report.rows.filter((r) => r.status === 'mismatch')).toEqual([])
    expect(lastOffer()).toBeNull()
    await run(10, { lat: 61, lon: -150 })
    expect(store.saves).toBe(1)
  })

  it('keeps the saved state after declining until the aircraft actually moves', async () => {
    store.records.set(KEY, saved(elsewhere))
    await run(2)
    tracker.decline()
    await run(30)
    expect(store.saves).toBe(0)
    expect(store.get(KEY)?.snapshot.values['position.latitude']).toBe(61)

    await run(5, { gsKts: 20 })
    await run(8)
    expect(store.saves).toBe(1)
  })

  it('treats starting to move as declining', async () => {
    store.records.set(KEY, saved(elsewhere))
    await run(2)
    await run(1, { gsKts: 15 })
    expect(lastOffer()).toBeNull()
    expect(port.moved).toBe(0)
  })

  it('makes no offer when the aircraft is already as you left it', async () => {
    store.records.set(KEY, saved({}))
    await run(2)
    expect(offers).toEqual([])
  })

  it('makes no offer with the setting off', async () => {
    settings.saveAircraftLocation = false
    store.records.set(KEY, saved(elsewhere))
    await run(5)
    expect(offers).toEqual([])
  })

  it('clears the offer when the sim goes back to loading', async () => {
    store.records.set(KEY, saved(elsewhere))
    await run(2)
    await run(1, { lat: 0.00002, lon: 0.00001 })
    expect(lastOffer()).toBeNull()
  })

  it('offers again after a reload', async () => {
    store.records.set(KEY, saved(elsewhere))
    await run(2)
    tracker.reset()
    await run(2)
    expect(lastOffer()).not.toBeNull()
  })

  it('refuses to restore when nothing is on offer', async () => {
    await expect(tracker.accept()).rejects.toThrow('nothing to restore')
  })
})

describe('saving and restoring from the Hangar', () => {
  it('saves the loaded aircraft on request, even with automatic saving off', async () => {
    settings.saveAircraftLocation = false
    await run(2)
    const snapshot = await tracker.captureNow(KEY)
    expect(snapshot.aircraft.title).toBe('Comanche')
    expect(snapshot.values['position.latitude']).toBe(38)
  })

  it('refuses to save or restore an aircraft that is not loaded', async () => {
    await run(2)
    await expect(tracker.captureNow('Something else|Blue')).rejects.toThrow('Load this aircraft')
    await expect(tracker.restoreNow('Something else|Blue', saved(elsewhere).snapshot)).rejects.toThrow('Load this aircraft')
  })

  it('waits for the sim to finish loading before restoring', async () => {
    await expect(tracker.restoreNow(KEY, saved(elsewhere).snapshot)).rejects.toThrow('finish loading')
  })

  it('restores a chosen save, withdraws the load-time offer, and saves again afterwards', async () => {
    store.records.set(KEY, saved(elsewhere))
    await run(2)
    expect(lastOffer()).not.toBeNull()
    const older = saved({ ...elsewhere, 'position.latitude': 50 }).snapshot
    await tracker.restoreNow(KEY, older)
    expect(port.values['position.latitude']).toBe(50)
    expect(lastOffer()).toBeNull()
    await run(10, { lat: 50, lon: -150 })
    expect(store.saves).toBe(1)
  })

  it('restores only what the player picked', async () => {
    await run(2)
    const report = await tracker.restoreNow(KEY, saved(elsewhere).snapshot, { categories: ['electrical'], positionMethod: 'initposition' })
    expect(port.moved).toBe(0)
    expect(port.values['electrical.battery1']).toBe(1)
    expect(report.rows.some((row) => row.category === 'position' && row.status === 'restored')).toBe(false)
  })

  it('a manual save replaces the state that was waiting to be restored', async () => {
    store.records.set(KEY, saved(elsewhere))
    await run(2)
    await tracker.captureNow(KEY)
    expect(lastOffer()).toBeNull()
  })
})

describe('with No teleport on, the aircraft stays where it really is', () => {
  // Pretends the aircraft's home is at 61, -150, so the fake sim's 38, -121 is somewhere else.
  const awayFromAnchorage = (_key: string, lat: number) => (Math.abs(lat - 61) > 0.05 ? "It's at Anchorage (PANC)." : null)
  const gated = () => new AirframeTracker(port, store, () => settings, (offer) => offers.push(offer), noWait, awayFromAnchorage)

  it('does not save the aircraft while it is somewhere else', async () => {
    tracker = gated()
    await run(40)
    expect(store.saves).toBe(0)
  })

  it('saves it again once it is back home', async () => {
    tracker = gated()
    port.values['position.latitude'] = 61
    await run(10, { lat: 61, lon: -150 })
    expect(store.saves).toBe(1)
  })

  it('explains why Save now is refused away from home', async () => {
    tracker = gated()
    await run(2)
    await expect(tracker.captureNow(KEY)).rejects.toThrow("only be saved where it last landed. It's at Anchorage (PANC).")
  })

  it('still restores it, which brings it home', async () => {
    tracker = gated()
    await run(2)
    await tracker.restoreNow(KEY, saved(elsewhere).snapshot)
    expect(port.values['position.latitude']).toBe(61)
  })
})
