import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { AirportIndex } from '../core/airports'
import type { Airport } from '../shared/journey'
import type { Snapshot } from '../shared/types'
import { AirframeDatabase } from './airframes'

const airport = (ident: string, lat: number, lon: number): Airport => ({
  ident,
  name: ident,
  lat,
  lon,
  elevationFt: 0,
  size: 'small',
  city: '',
  country: 'US',
  runwayFt: 3000,
  hardSurface: true,
  scheduled: false
})
const airports = new AirportIndex([airport('KRIU', 38.49, -121.1), airport('KSAC', 38.51, -121.49)])
const KEY = 'Comanche|Red'

let minute = 0
function snapshot(lat: number, lon: number, overrides: Partial<Snapshot> = {}): Snapshot {
  minute++
  return {
    id: KEY,
    name: 'Comanche',
    capturedAt: new Date(Date.UTC(2026, 10, 1, 0, minute)).toISOString(),
    aircraft: { title: 'Comanche', livery: 'Red', atcId: 'N1' },
    profileId: 'default',
    engineCount: 1,
    parked: true,
    values: { 'position.latitude': lat, 'position.longitude': lon, 'fuel.leftMain': 20 },
    ...overrides
  }
}

let db: AirframeDatabase
beforeEach(() => {
  db = new AirframeDatabase(join(mkdtempSync(join(tmpdir(), 'journeys-test-')), 'logbook.db'), airports)
})

describe('aircraft save history', () => {
  it('keeps one entry per parking spot, updated while the aircraft sits there', () => {
    db.save(KEY, snapshot(38.49, -121.1))
    db.save(KEY, snapshot(38.49001, -121.1))
    expect(db.history(KEY)).toHaveLength(1)
    expect(db.history(KEY)[0]).toMatchObject({ kind: 'parked', name: 'Parked at KRIU' })
    expect(db.history(KEY)[0].snapshot.values['position.latitude']).toBe(38.49001)

    db.save(KEY, snapshot(38.51, -121.49))
    expect(db.history(KEY).map((s) => s.name)).toEqual(['Parked at KSAC', 'Parked at KRIU'])
  })

  it('adds manual saves, which also become the current save', () => {
    db.save(KEY, snapshot(38.49, -121.1))
    const manual = db.saveManual(KEY, snapshot(38.49, -121.1), '')
    expect(manual).toMatchObject({ kind: 'manual', name: 'Saved at KRIU' })
    expect(db.get(KEY)?.snapshot.capturedAt).toBe(manual.snapshot.capturedAt)
    expect(db.saveManual(KEY, snapshot(38.49, -121.1), 'Before the trip').name).toBe('Before the trip')
    expect(db.history(KEY)).toHaveLength(3)
  })

  it('keeps manual saves but drops the oldest parking spots', () => {
    db.saveManual(KEY, snapshot(38, -121), 'Keep me')
    for (let i = 0; i < 40; i++) db.save(KEY, snapshot(30 + i * 0.1, -100))
    const history = db.history(KEY)
    expect(history.filter((s) => s.kind === 'parked')).toHaveLength(30)
    expect(history.some((s) => s.name === 'Keep me')).toBe(true)
  })

  it('renames and deletes single saves, and forgets everything with the aircraft', () => {
    const manual = db.saveManual(KEY, snapshot(38.49, -121.1), 'One')
    expect(db.renameSave(manual.id, 'Two').name).toBe('Two')
    expect(db.renameSave(manual.id, '  ').name).toBe('Two')
    db.deleteSave(manual.id)
    expect(() => db.getSave(manual.id)).toThrow('no longer exists')

    db.save(KEY, snapshot(38.49, -121.1))
    db.delete(KEY)
    expect(db.get(KEY)).toBeNull()
    expect(db.history(KEY)).toEqual([])
  })

  it('imports the old Restore lab saves once', () => {
    const lab = [
      snapshot(38.49, -121.1, { id: 'lab-1', name: 'Cold and dark' }),
      snapshot(38.51, -121.49, { id: 'lab-2', name: 'Other plane', aircraft: { title: 'Cub', livery: '', atcId: '' } })
    ]
    expect(db.importLabSaves(lab)).toBe(2)
    expect(db.history(KEY).map((s) => s.name)).toEqual(['Cold and dark'])
    expect(db.get('Cub|')?.location?.ident).toBe('KSAC')
    expect(db.importLabSaves(lab)).toBe(0)
    expect(db.history(KEY)).toHaveLength(1)
  })
})
