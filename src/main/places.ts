import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { AirportIndex } from '../core/airports'
import type { Place, PlaceKind } from '../shared/journey'

/** Airports the player has pinned: home fields, places they've been, places they want to go. */
export class PlaceStore {
  private readonly db: DatabaseSync

  constructor(
    databasePath: string,
    private readonly airports: AirportIndex
  ) {
    this.db = new DatabaseSync(databasePath)
    this.db.exec(`
      PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS places (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL);
    `)
  }

  list(): Place[] {
    return this.db
      .prepare('SELECT data FROM places ORDER BY created_at')
      .all()
      .map((row) => JSON.parse(String(row.data)) as Place)
  }

  add(ident: string, kind: PlaceKind, note: string): Place {
    const airport = this.airports.get(ident)
    if (!airport) throw new Error(`Couldn't find an airport called ${ident.trim() || 'that'}.`)
    const existing = this.list().find((place) => place.ident === airport.ident)
    const place: Place = {
      id: existing?.id ?? randomUUID(),
      ident: airport.ident,
      name: airport.name,
      city: airport.city,
      lat: airport.lat,
      lon: airport.lon,
      kind,
      note: note.trim()
    }
    this.db
      .prepare('INSERT INTO places (id, created_at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(place.id, Date.now(), JSON.stringify(place))
    return place
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM places WHERE id = ?').run(id)
  }
}
